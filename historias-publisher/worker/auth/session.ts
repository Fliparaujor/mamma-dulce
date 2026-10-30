import { all, changes, first, nowIso, run } from '../lib/db';
import { clientIp, HttpError } from '../lib/http';
import { randomToken, sha256Hex, timingSafeEqual, verifyPassword } from '../lib/crypto';
import type { Env } from '../env';

export const SESSION_COOKIE = '__Host-hp_session';
const SESSION_TTL_MS = 14 * 24 * 3600_000;
const SESSION_IDLE_MS = 3 * 24 * 3600_000;

const IP_MAX_FAILURES = 5;
const GLOBAL_MAX_FAILURES = 20;
const FAILURE_WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;

export interface Session {
  id: string;
  csrfToken: string;
  expiresAt: string;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

async function ipKey(req: Request): Promise<string> {
  return `ip:${(await sha256Hex(clientIp(req))).slice(0, 32)}`;
}

interface AttemptRow {
  key: string;
  failures: number;
  window_start: string;
  locked_until: string | null;
}

async function lockStatus(env: Env, keys: string[], now: Date): Promise<string | null> {
  const rows = await all<AttemptRow>(
    env.DB,
    `SELECT * FROM login_attempts WHERE key IN (${keys.map(() => '?').join(',')})`,
    ...keys,
  );
  for (const r of rows) {
    if (r.locked_until && r.locked_until > now.toISOString()) return r.locked_until;
  }
  return null;
}

async function registerFailure(env: Env, key: string, limit: number, now: Date): Promise<void> {
  const nowS = now.toISOString();
  const windowStart = new Date(now.getTime() - FAILURE_WINDOW_MS).toISOString();
  const lockUntil = new Date(now.getTime() + LOCK_MS).toISOString();
  await run(
    env.DB,
    `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?, 1, ?, NULL)
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN login_attempts.window_start < ? THEN 1 ELSE login_attempts.failures + 1 END,
       window_start = CASE WHEN login_attempts.window_start < ? THEN ? ELSE login_attempts.window_start END,
       locked_until = CASE
         WHEN (CASE WHEN login_attempts.window_start < ? THEN 1 ELSE login_attempts.failures + 1 END) >= ? THEN ?
         ELSE login_attempts.locked_until END`,
    key,
    nowS,
    windowStart,
    windowStart,
    nowS,
    windowStart,
    limit,
    lockUntil,
  );
}

export async function login(env: Env, req: Request, password: string, now = new Date()): Promise<{ token: string; session: Session }> {
  if (!env.ADMIN_PASSWORD_HASH) {
    throw new HttpError(503, 'Senha do administrador não configurada. Defina o segredo ADMIN_PASSWORD_HASH.', 'not_configured');
  }
  const ip = await ipKey(req);
  const locked = await lockStatus(env, [ip, 'global'], now);
  if (locked) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.', 'locked', { lockedUntil: locked });
  }
  const ok = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!ok) {
    await registerFailure(env, ip, IP_MAX_FAILURES, now);
    await registerFailure(env, 'global', GLOBAL_MAX_FAILURES, now);
    throw new HttpError(401, 'Senha incorreta.', 'invalid_credentials');
  }
  await run(env.DB, 'DELETE FROM login_attempts WHERE key = ?', ip);

  const token = randomToken(32);
  const id = await sha256Hex(token);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now.toISOString()),
    env.DB.prepare(
      `INSERT INTO admin_sessions (id, csrf_token, created_at, last_seen_at, expires_at, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, csrfToken, now.toISOString(), now.toISOString(), expiresAt, ip, (req.headers.get('user-agent') ?? '').slice(0, 200)),
  ]);
  return { token, session: { id, csrfToken, expiresAt } };
}

interface SessionRow {
  id: string;
  csrf_token: string;
  last_seen_at: string;
  expires_at: string;
}

export async function getSession(env: Env, req: Request, now = new Date()): Promise<Session | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length < 20 || token.length > 128) return null;
  const id = await sha256Hex(token);
  const row = await first<SessionRow>(env.DB, 'SELECT id, csrf_token, last_seen_at, expires_at FROM admin_sessions WHERE id = ?', id);
  if (!row) return null;
  const nowMs = now.getTime();
  if (row.expires_at <= now.toISOString() || nowMs - new Date(row.last_seen_at).getTime() > SESSION_IDLE_MS) {
    await run(env.DB, 'DELETE FROM admin_sessions WHERE id = ?', id);
    return null;
  }
  // Atualiza "visto por último" no máximo a cada 10 minutos para poupar escritas.
  if (nowMs - new Date(row.last_seen_at).getTime() > 10 * 60_000) {
    await run(env.DB, 'UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?', nowIso(now), id);
  }
  return { id: row.id, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

export async function logout(env: Env, session: Session): Promise<void> {
  const res = await run(env.DB, 'DELETE FROM admin_sessions WHERE id = ?', session.id);
  void changes(res);
}

/**
 * Proteção CSRF para métodos que alteram estado:
 * cookie SameSite=Strict + cabeçalho X-CSRF-Token igual ao da sessão + Origin do mesmo site quando presente.
 */
export function assertCsrf(req: Request, session: Session): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = req.headers.get('origin');
  if (origin) {
    const reqOrigin = new URL(req.url).origin;
    if (origin !== reqOrigin) throw new HttpError(403, 'Origem da requisição não permitida.', 'bad_origin');
  }
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'Requisição de outro site bloqueada.', 'bad_origin');
  }
  const header = req.headers.get('x-csrf-token') ?? '';
  if (!header || !timingSafeEqual(header, session.csrfToken)) {
    throw new HttpError(403, 'Token CSRF ausente ou inválido. Recarregue a página.', 'csrf');
  }
}
