import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import { app } from '../worker/app';
import { bufferTestHooks } from '../worker/buffer/factory';
import type { Env } from '../worker/env';
import { saveSettings, type Settings } from '../worker/settings';
import { FakeBuffer } from './fake-buffer';

export type TestEnv = Env & { TEST_PASSWORD: string };
export const env = rawEnv as unknown as TestEnv;

export const ORIGIN = 'https://publisher.example.com';

const TABLES = [
  'publication_attempts',
  'publication_jobs',
  'episode_platforms',
  'episodes',
  'series',
  'media_assets',
  'social_channels',
  'scheduler_runs',
  'admin_sessions',
  'login_attempts',
  'locks',
  'usage_daily',
  'app_settings',
];

export async function resetDb(): Promise<void> {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  bufferTestHooks.fetch = null;
  bufferTestHooks.retryDelaysMs = [0, 0];
}

export function installFakeBuffer(): FakeBuffer {
  const fake = new FakeBuffer();
  bufferTestHooks.fetch = fake.fetch as typeof fetch;
  bufferTestHooks.retryDelaysMs = [0, 0];
  return fake;
}

export async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: Auth | null; headers?: Record<string, string>; rawBody?: BodyInit; envOverride?: Partial<Env> } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.auth) {
    headers.set('cookie', opts.auth.cookie);
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('x-csrf-token')) headers.set('x-csrf-token', opts.auth.csrf);
  }
  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const ctx = createExecutionContext();
  const res = await app.fetch(req, { ...env, ...(opts.envOverride ?? {}) }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export interface Auth {
  cookie: string;
  csrf: string;
}

export async function login(): Promise<Auth> {
  const res = await call('POST', '/api/auth/login', { body: { password: env.TEST_PASSWORD }, headers: { origin: ORIGIN } });
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0]!;
  const body = (await res.json()) as { csrfToken: string };
  return { cookie, csrf: body.csrfToken };
}

/** Um MP4 mínimo (só a caixa ftyp) — suficiente para a validação de assinatura do upload. */
export function fakeMp4(size = 64): Uint8Array {
  const buf = new Uint8Array(size);
  buf.set([0, 0, 0, 24], 0);
  buf.set(new TextEncoder().encode('ftypisom'), 4);
  return buf;
}

export async function seedReadyAsset(id = crypto.randomUUID(), filename = 'video.mp4', opts: { width?: number; height?: number } = {}): Promise<string> {
  const key = `videos/test/${id}.mp4`;
  const data = fakeMp4(128);
  await env.MEDIA.put(key, data, { httpMetadata: { contentType: 'video/mp4' } });
  await env.DB.prepare(
    `INSERT INTO media_assets (id, r2_key, original_filename, content_type, size_bytes, status, upload_mode, public_token, created_at, uploaded_at, width, height)
     VALUES (?, ?, ?, 'video/mp4', ?, 'ready', 'proxy', ?, ?, ?, ?, ?)`,
  )
    .bind(id, key, filename, data.length, `tok_${id.replace(/-/g, '')}`, new Date().toISOString(), new Date().toISOString(), opts.width ?? 1080, opts.height ?? 1920)
    .run();
  return id;
}

/** Cria uma série com `count` episódios, cada um com vídeo pronto e legenda. Devolve os IDs em ordem. */
export async function seedEpisodes(count: number, seriesTitle = 'Historia 01'): Promise<number[]> {
  const now = new Date().toISOString();
  const series = await env.DB.prepare(
    `INSERT INTO series (slug, title, position, created_at, updated_at) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM series), ?, ?) RETURNING id`,
  )
    .bind(seriesTitle.toLowerCase().replace(/\W+/g, '-'), seriesTitle, now, now)
    .first<{ id: number }>();
  const ids: number[] = [];
  for (let i = 1; i <= count; i++) {
    const asset = await seedReadyAsset(undefined, `${seriesTitle}_Ep${String(i).padStart(2, '0')}.mp4`);
    const row = await env.DB.prepare(
      `INSERT INTO episodes (series_id, episode_number, title, media_asset_id, shared_caption, shared_hashtags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(series!.id, i, `${seriesTitle} · Episódio ${i}`, asset, `Episódio ${i} da história.`, '#historias #lendas', now, now)
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  return ids;
}

export async function configureBuffer(patch: Partial<Settings> = {}): Promise<void> {
  await saveSettings(env, {
    bufferOrganizationId: 'org_1',
    maxCreatesPerRun: 20,
    maxBufferRequestsPerRun: 40,
    dailyBufferBudget: 1000,
    ...patch,
  });
  const nowS = new Date().toISOString();
  await env.DB.batch(
    [
      ['instagram', 'ch_ig'],
      ['tiktok', 'ch_tt'],
      ['youtube', 'ch_yt'],
    ].map(([platform, ext]) =>
      env.DB.prepare(
        `INSERT INTO social_channels (platform, provider, external_id, organization_id, name, queue_limit, created_at, updated_at)
         VALUES (?, 'buffer', ?, 'org_1', ?, 10, ?, ?)`,
      ).bind(platform, ext, `canal ${platform}`, nowS, nowS),
    ),
  );
}

export async function jobsByState(): Promise<Record<string, number>> {
  const rows = await env.DB.prepare('SELECT state, COUNT(*) AS n FROM publication_jobs GROUP BY state').all<{ state: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.state, r.n]));
}

/** Insere publicações diretamente: dois episódios por dia a partir de `start`, nas redes informadas. */
export async function scheduleJobs(episodeIds: number[], start: Date, platforms: string[] = ['instagram', 'tiktok', 'youtube']): Promise<void> {
  const nowS = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  episodeIds.forEach((id, i) => {
    const day = Math.floor(i / 2);
    const at = new Date(start.getTime() + day * 24 * 3600_000 + (i % 2) * 7 * 3600_000).toISOString();
    for (const p of platforms) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO publication_jobs (episode_id, platform, scheduled_at, state, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?)`,
        ).bind(id, p, at, nowS, nowS),
      );
    }
  });
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}
