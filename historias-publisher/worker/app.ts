import { Hono } from 'hono';
import { z } from 'zod';
import { assertCsrf, clearSessionCookie, getSession, login, logout, sessionCookie } from './auth/session';
import { kwaiIcs } from './kwai';
import { timingSafeEqual } from './lib/crypto';
import { first } from './lib/db';
import { HttpError, parseWith, readJson } from './lib/http';
import { log } from './lib/log';
import admin from './routes/admin';
import content from './routes/content';
import media from './routes/media';
import schedule from './routes/schedule';
import type { AppEnv } from './routes/types';
import { serveMedia } from './services/media';
import { getSettings, getState, publicBaseUrl, setState } from './settings';

export const app = new Hono<AppEnv>();

const API_SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, err.status as 400);
  }
  log('error', 'request.failed', { path: new URL(c.req.url).pathname, method: c.req.method, error: err.message });
  return c.json({ error: { code: 'internal', message: 'Erro interno. Tente novamente; se persistir, veja os logs do Worker.' } }, 500);
});

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Rota não encontrada.' } }, 404));

// ---------- Rotas públicas ----------

app.get('/healthz', async (c) => {
  const checks: Record<string, boolean> = {};
  try {
    checks.database = Boolean(await first(c.env.DB, 'SELECT 1 AS ok'));
  } catch {
    checks.database = false;
  }
  try {
    await c.env.MEDIA.head('healthcheck-inexistente');
    checks.storage = true;
  } catch {
    checks.storage = false;
  }
  try {
    checks.migrations = Boolean(await first(c.env.DB, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'publication_jobs'`));
  } catch {
    checks.migrations = false;
  }
  checks.adminPasswordConfigured = Boolean(c.env.ADMIN_PASSWORD_HASH);
  const ok = checks.database && checks.storage && checks.migrations && checks.adminPasswordConfigured;
  return c.json({ ok, checks, time: new Date().toISOString() }, ok ? 200 : 503, API_SECURITY_HEADERS);
});

app.on(['GET', 'HEAD'], '/media/:id/:token', (c) => serveMedia(c.env, c.req.raw, c.req.param('id'), c.req.param('token'), c.executionCtx as unknown as ExecutionContext));

app.get('/feeds/kwai/:token', async (c) => {
  const raw = c.req.param('token').replace(/\.ics$/, '');
  const expected = await getState<string>(c.env, 'ics_token');
  if (!expected || !timingSafeEqual(raw, expected)) return c.text('Não encontrado', 404);
  const settings = await getSettings(c.env);
  const base = publicBaseUrl(c.env, await getState<string>(c.env, 'public_origin')) ?? new URL(c.req.url).origin;
  const body = await kwaiIcs(c.env, base, settings.kwaiReminderMinutes, new Date());
  return new Response(body, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' },
  });
});

// ---------- Autenticação ----------

const api = new Hono<AppEnv>();

api.use('*', async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) c.res.headers.set(k, v);
});

api.post('/auth/login', async (c) => {
  const { password } = parseWith(z.object({ password: z.string().min(1).max(512) }), await readJson(c.req.raw));
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, 'Origem não permitida.', 'bad_origin');
  const { token, session } = await login(c.env, c.req.raw, password);
  // Guarda a origem HTTPS usada no login: serve de URL pública das mídias se PUBLIC_BASE_URL não for definida.
  const reqOrigin = new URL(c.req.url).origin;
  if (!c.env.PUBLIC_BASE_URL && publicBaseUrl(c.env, reqOrigin)) await setState(c.env, 'public_origin', reqOrigin);
  c.header('Set-Cookie', sessionCookie(token, 14 * 24 * 3600));
  return c.json({ authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
});

api.get('/auth/session', async (c) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) return c.json({ authenticated: false, passwordConfigured: Boolean(c.env.ADMIN_PASSWORD_HASH) });
  return c.json({ authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
});

// Daqui para baixo, toda rota exige sessão válida e (em métodos de escrita) token CSRF.
api.use('*', async (c, next) => {
  const session = await getSession(c.env, c.req.raw);
  if (!session) throw new HttpError(401, 'Sessão expirada. Entre novamente.', 'unauthenticated');
  assertCsrf(c.req.raw, session);
  c.set('session', session);
  await next();
});

api.post('/auth/logout', async (c) => {
  await logout(c.env, c.get('session'));
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

api.route('/', admin);
api.route('/', content);
api.route('/', media);
api.route('/', schedule);

app.route('/api', api);
