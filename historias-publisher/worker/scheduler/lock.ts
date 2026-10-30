import { changes, run } from '../lib/db';
import type { Env } from '../env';

/**
 * Trava distribuída simples no D1. Só um agendador por vez; a trava expira sozinha
 * caso uma execução morra no meio (o Worker pode ser interrompido sem aviso).
 */
export const SCHEDULER_LOCK = 'scheduler';
export const SCHEDULER_LOCK_TTL_MS = 10 * 60_000;

export async function acquireLock(env: Env, name: string, holder: string, ttlMs: number, now = new Date()): Promise<boolean> {
  const res = await run(
    env.DB,
    `INSERT INTO locks (name, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
     WHERE locks.expires_at < excluded.acquired_at`,
    name,
    holder,
    now.toISOString(),
    new Date(now.getTime() + ttlMs).toISOString(),
  );
  return changes(res) === 1;
}

export function releaseLockStatement(env: Env, name: string, holder: string): D1PreparedStatement {
  return env.DB.prepare('DELETE FROM locks WHERE name = ? AND holder = ?').bind(name, holder);
}

export async function releaseLock(env: Env, name: string, holder: string): Promise<void> {
  await releaseLockStatement(env, name, holder).run();
}
