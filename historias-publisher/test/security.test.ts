import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../worker/lib/crypto';
import { redact } from '../worker/lib/log';
import { call, env, login, ORIGIN, resetDb } from './helpers';

beforeEach(resetDb);

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/api/dashboard'],
  ['GET', '/api/usage'],
  ['GET', '/api/settings'],
  ['PATCH', '/api/settings'],
  ['GET', '/api/series'],
  ['POST', '/api/series'],
  ['GET', '/api/episodes'],
  ['POST', '/api/episodes/import'],
  ['POST', '/api/episodes/batch'],
  ['GET', '/api/media'],
  ['POST', '/api/uploads'],
  ['DELETE', '/api/media/00000000-0000-0000-0000-000000000000'],
  ['POST', '/api/media/cleanup'],
  ['POST', '/api/calendar/preview'],
  ['POST', '/api/calendar/commit'],
  ['GET', '/api/jobs'],
  ['POST', '/api/jobs/1/cancel'],
  ['POST', '/api/jobs/1/retry'],
  ['POST', '/api/jobs/1/manual-confirm'],
  ['POST', '/api/scheduler/run'],
  ['GET', '/api/channels'],
  ['POST', '/api/buffer/test'],
  ['POST', '/api/buffer/sync-channels'],
  ['GET', '/api/kwai/queue'],
  ['POST', '/api/auth/logout'],
];

describe('rotas administrativas exigem sessão', () => {
  it.each(ADMIN_ROUTES)('%s %s sem cookie → 401', async (method, path) => {
    const res = await call(method, path, { body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('cookie forjado não vale', async () => {
    const res = await call('GET', '/api/dashboard', { headers: { cookie: '__Host-hp_session=forjado-forjado-forjado-forjado' } });
    expect(res.status).toBe(401);
  });

  it('com sessão válida responde 200', async () => {
    const auth = await login();
    const res = await call('GET', '/api/dashboard', { auth });
    expect(res.status).toBe(200);
  });
});

describe('login', () => {
  it('define cookie HttpOnly, Secure, SameSite=Strict com prefixo __Host-', async () => {
    const res = await call('POST', '/api/auth/login', { body: { password: env.TEST_PASSWORD } });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-hp_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/);
  });

  it('senha errada → 401 e bloqueio após 5 tentativas', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await call('POST', '/api/auth/login', { body: { password: 'errada' } });
      expect(res.status).toBe(401);
    }
    const blocked = await call('POST', '/api/auth/login', { body: { password: env.TEST_PASSWORD } });
    expect(blocked.status).toBe(429);
  });

  it('o banco guarda só o hash do token de sessão', async () => {
    const auth = await login();
    const token = auth.cookie.split('=')[1]!;
    const rows = await env.DB.prepare('SELECT id FROM admin_sessions').all<{ id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.id).not.toBe(token);
    expect(rows.results![0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logout invalida a sessão', async () => {
    const auth = await login();
    expect((await call('POST', '/api/auth/logout', { auth, body: {} })).status).toBe(200);
    expect((await call('GET', '/api/dashboard', { auth })).status).toBe(401);
  });

  it('hash PBKDF2 confere e rejeita senha diferente', async () => {
    const stored = await hashPassword('outra senha forte', 10_000);
    expect(await verifyPassword('outra senha forte', stored)).toBe(true);
    expect(await verifyPassword('outra senha fraca', stored)).toBe(false);
    expect(await verifyPassword('x', 'formato-invalido')).toBe(false);
  });
});

describe('CSRF', () => {
  it('escrita sem X-CSRF-Token → 403', async () => {
    const auth = await login();
    const res = await call('POST', '/api/series', { auth, body: { title: 'X' }, headers: { 'x-csrf-token': '' } });
    expect(res.status).toBe(403);
  });

  it('escrita com token errado → 403', async () => {
    const auth = await login();
    const res = await call('POST', '/api/series', { auth, body: { title: 'X' }, headers: { 'x-csrf-token': 'token-errado' } });
    expect(res.status).toBe(403);
  });

  it('escrita vinda de outra origem → 403', async () => {
    const auth = await login();
    const res = await call('POST', '/api/series', { auth, body: { title: 'X' }, headers: { origin: 'https://site-malicioso.example' } });
    expect(res.status).toBe(403);
  });

  it('escrita da mesma origem com token → 201', async () => {
    const auth = await login();
    const res = await call('POST', '/api/series', { auth, body: { title: 'Lendas' }, headers: { origin: ORIGIN } });
    expect(res.status).toBe(201);
  });
});

describe('validação de entradas', () => {
  it('JSON inválido e campos fora do schema → 400 com mensagem', async () => {
    const auth = await login();
    const bad = await call('POST', '/api/series', { auth, rawBody: '{', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    const res = await call('POST', '/api/calendar/preview', {
      auth,
      body: { startDate: '2026-13-40', days: 30, times: ['25:00'], platforms: ['orkut'] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/inválid/i);
  });

  it('configurações rejeitam valores perigosos', async () => {
    const auth = await login();
    const res = await call('PATCH', '/api/settings', { auth, body: { schedulerIntervalMinutes: 1 } });
    expect(res.status).toBe(400);
  });
});

describe('segredos não vazam', () => {
  it('nenhuma resposta expõe a chave do Buffer ou o hash da senha', async () => {
    const auth = await login();
    for (const path of ['/api/settings', '/api/dashboard', '/api/usage', '/api/channels', '/healthz']) {
      const text = await (await call('GET', path, { auth })).text();
      expect(text).not.toContain(env.BUFFER_API_KEY!);
      expect(text).not.toContain(env.ADMIN_PASSWORD_HASH!);
    }
  });

  it('logs mascaram credenciais', () => {
    const out = JSON.stringify(
      redact({
        authorization: 'Bearer abc',
        nested: { apiKey: 'x', password: 'y' },
        url: 'https://r2.example/obj?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA',
        msg: 'falhou com Bearer sk_live_123',
      }),
    );
    expect(out).not.toMatch(/abc|deadbeef|AKIA|sk_live_123/);
    expect(out).toContain('[oculto]');
  });
});

describe('rotas públicas', () => {
  it('healthz responde sem sessão e sem dados sensíveis', async () => {
    const res = await call('GET', '/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, boolean> };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.checks).sort()).toEqual(['adminPasswordConfigured', 'database', 'migrations', 'storage']);
  });

  it('feed do Kwai exige o token secreto', async () => {
    expect((await call('GET', '/feeds/kwai/qualquer.ics')).status).toBe(404);
  });
});
