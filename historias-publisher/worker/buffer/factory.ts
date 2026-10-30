import { utcDay } from '../lib/db';
import { statement } from '../settings';
import type { Env } from '../env';
import { BufferApi } from './api';
import { BufferClient, type RateLimitSnapshot } from './client';

/** Ganchos usados somente pelos testes para trocar o transporte HTTP por um Buffer falso. */
export const bufferTestHooks: { fetch: typeof fetch | null; retryDelaysMs: number[] | null } = {
  fetch: null,
  retryDelaysMs: null,
};

export interface BufferSession {
  api: BufferApi;
  /** Persiste contadores e cabeçalhos de cota em uma única escrita em lote (economiza consultas ao D1). */
  flush(): Promise<void>;
  readonly requests: number;
  readonly lastRateLimit: RateLimitSnapshot | null;
}

export function isBufferConfigured(env: Env): boolean {
  return Boolean(env.BUFFER_API_KEY && env.BUFFER_API_KEY.trim().length > 0);
}

export function createBufferSession(env: Env, opts: { maxRequests?: number } = {}): BufferSession | null {
  if (!isBufferConfigured(env)) return null;
  let requests = 0;
  let flushed = 0;
  let lastRateLimit: RateLimitSnapshot | null = null;
  const endpoint = env.BUFFER_API_URL && /^https:\/\//.test(env.BUFFER_API_URL) ? env.BUFFER_API_URL : undefined;
  const client = new BufferClient({
    apiKey: env.BUFFER_API_KEY!.trim(),
    endpoint,
    fetchImpl: bufferTestHooks.fetch ?? undefined,
    retryDelaysMs: bufferTestHooks.retryDelaysMs ?? undefined,
    maxRequests: opts.maxRequests,
    onResponse: (meta) => {
      requests++;
      if (meta.rateLimit) lastRateLimit = meta.rateLimit;
    },
  });
  return {
    api: new BufferApi(client),
    get requests() {
      return requests;
    },
    get lastRateLimit() {
      return lastRateLimit;
    },
    async flush() {
      const pending = requests - flushed;
      const stmts: D1PreparedStatement[] = [];
      if (pending > 0) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO usage_daily (day, metric, value) VALUES (?, 'buffer_requests', ?)
             ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`,
          ).bind(utcDay(), pending),
        );
      }
      if (lastRateLimit) stmts.push(statement(env, 'buffer_rate_limit', lastRateLimit));
      if (stmts.length) await env.DB.batch(stmts);
      flushed = requests;
    },
  };
}
