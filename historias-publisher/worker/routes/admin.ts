import { Hono } from 'hono';
import { z } from 'zod';
import { BUFFER_PLATFORMS } from '../../shared/constants';
import type { RateLimitSnapshot } from '../buffer/client';
import { isBufferConfigured } from '../buffer/factory';
import { randomToken } from '../lib/crypto';
import { all, first, nowIso, run, utcDay } from '../lib/db';
import { notFound, parseWith, readJson } from '../lib/http';
import { canPresign, maxUploadBytes } from '../services/media';
import { ensureKwaiChannel, listChannels, mapChannel, selectOrganization, syncChannels, testConnection } from '../services/channels';
import { getSettings, getState, publicBaseUrl, saveSettings, setState, settingsPatchSchema } from '../settings';
import type { AppEnv } from './types';

const admin = new Hono<AppEnv>();

const GB = 1024 ** 3;

/** Preços públicos do R2 (classe Standard) em USD — https://developers.cloudflare.com/r2/pricing/ */
export const R2_PRICING = {
  storagePerGBMonth: 0.015,
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  free: { storageGB: 10, classA: 1_000_000, classB: 10_000_000 },
};

/** Limites documentados do Buffer — https://developers.buffer.com/guides/api-limits.html */
export const BUFFER_LIMITS = {
  free: { per15min: 150, perDay: 600, per30DaysPerChannel: 1000, per30DaysMax: 3000, scheduledPerChannel: 10, channels: 3 },
};

async function sumUsage(db: D1Database, metric: string, sinceDay: string): Promise<number> {
  const row = await first<{ v: number | null }>(db, 'SELECT SUM(value) AS v FROM usage_daily WHERE metric = ? AND day >= ?', metric, sinceDay);
  return row?.v ?? 0;
}

async function icsToken(env: AppEnv['Bindings']): Promise<string> {
  let token = await getState<string>(env, 'ics_token');
  if (!token) {
    token = randomToken(24);
    await setState(env, 'ics_token', token);
  }
  return token;
}

admin.get('/dashboard', async (c) => {
  const env = c.env;
  const now = new Date();
  const settings = await getSettings(env);
  const [counts, jobStates, upcoming, channels, storage, lastRun, backoff, rateLimit, today, origin] = await Promise.all([
    first<{ episodes: number; without_media: number; without_jobs: number }>(
      env.DB,
      `SELECT COUNT(*) AS episodes,
              SUM(CASE WHEN media_asset_id IS NULL THEN 1 ELSE 0 END) AS without_media,
              SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM publication_jobs j WHERE j.episode_id = e.id AND j.state <> 'cancelled') THEN 1 ELSE 0 END) AS without_jobs
       FROM episodes e`,
    ),
    all<{ state: string; n: number }>(env.DB, 'SELECT state, COUNT(*) AS n FROM publication_jobs GROUP BY state'),
    all<{ id: number; platform: string; scheduled_at: string; state: string; episode_title: string; series_title: string; episode_number: number }>(
      env.DB,
      `SELECT j.id, j.platform, j.scheduled_at, j.state, e.title AS episode_title, s.title AS series_title, e.episode_number
       FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id JOIN series s ON s.id = e.series_id
       WHERE j.scheduled_at >= ? AND j.state NOT IN ('cancelled', 'published')
       ORDER BY j.scheduled_at ASC, j.platform ASC LIMIT 12`,
      now.toISOString(),
    ),
    listChannels(env),
    first<{ n: number; bytes: number | null }>(env.DB, `SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM media_assets WHERE status = 'ready'`),
    first<{ id: number; trigger: string; started_at: string; finished_at: string | null; status: string; summary: string | null; api_calls: number; error: string | null }>(
      env.DB,
      'SELECT * FROM scheduler_runs ORDER BY id DESC LIMIT 1',
    ),
    getState<string>(env, 'buffer_backoff_until'),
    getState<RateLimitSnapshot>(env, 'buffer_rate_limit'),
    first<{ v: number }>(env.DB, `SELECT value AS v FROM usage_daily WHERE day = ? AND metric = 'buffer_requests'`, utcDay(now)),
    getState<string>(env, 'public_origin'),
  ]);
  const byState = Object.fromEntries(jobStates.map((r) => [r.state, r.n]));
  const localOccupancy = await all<{ channel_id: number; n: number }>(
    env.DB,
    `SELECT channel_id, COUNT(*) AS n FROM publication_jobs WHERE state IN ('creating', 'scheduled_buffer') GROUP BY channel_id`,
  );

  const warnings: string[] = [];
  if (!isBufferConfigured(env)) warnings.push('Buffer não conectado: defina o segredo BUFFER_API_KEY.');
  else if (!settings.bufferOrganizationId) warnings.push('Escolha a organização do Buffer em Redes conectadas.');
  if (!publicBaseUrl(env, origin)) warnings.push('URL pública HTTPS do app desconhecida: defina PUBLIC_BASE_URL para o Buffer conseguir baixar os vídeos.');
  if (settings.dryRun) warnings.push('Modo simulação ligado: nada está sendo enviado ao Buffer.');
  if (settings.autofillPaused) warnings.push('Abastecimento automático da fila pausado.');
  if (backoff && backoff > now.toISOString()) warnings.push(`Limite de requisições do Buffer atingido; pausa até ${backoff}.`);
  if ((byState.needs_attention ?? 0) > 0) warnings.push(`${byState.needs_attention} publicação(ões) requerem atenção.`);

  return c.json({
    now: now.toISOString(),
    timezone: settings.timezone,
    defaultTimes: settings.defaultTimes,
    counts: {
      episodes: counts?.episodes ?? 0,
      episodesWithoutMedia: counts?.without_media ?? 0,
      episodesPending: counts?.without_jobs ?? 0,
      jobsByState: byState,
      manualPending: byState.manual_pending ?? 0,
    },
    upcoming: upcoming.map((u) => ({
      id: u.id,
      platform: u.platform,
      scheduledAt: u.scheduled_at,
      state: u.state,
      episodeTitle: u.episode_title,
      seriesTitle: u.series_title,
      episodeNumber: u.episode_number,
    })),
    channels: channels.map((ch) => ({
      id: ch.id,
      platform: ch.platform,
      provider: ch.provider,
      name: ch.display_name || ch.name,
      avatarUrl: ch.avatar_url,
      enabled: ch.enabled === 1,
      isDisconnected: ch.is_disconnected === 1,
      isLocked: ch.is_locked === 1,
      isQueuePaused: ch.is_queue_paused === 1,
      defaultToReminders: ch.default_to_reminders === null ? null : ch.default_to_reminders === 1,
      queueLimit: ch.queue_limit,
      bufferScheduled: ch.buffer_scheduled_count,
      appScheduled: localOccupancy.find((o) => o.channel_id === ch.id)?.n ?? 0,
      lastSyncedAt: ch.last_synced_at,
    })),
    buffer: {
      configured: isBufferConfigured(env),
      organizationSelected: Boolean(settings.bufferOrganizationId),
      dryRun: settings.dryRun,
      autofillPaused: settings.autofillPaused,
      backoffUntil: backoff,
      rateLimit,
      requestsToday: today?.v ?? 0,
      dailyBudget: settings.dailyBufferBudget,
    },
    storage: { assets: storage?.n ?? 0, bytes: storage?.bytes ?? 0 },
    lastRun: lastRun ? { ...lastRun, summary: lastRun.summary ? JSON.parse(lastRun.summary) : null } : null,
    warnings,
  });
});

admin.get('/usage', async (c) => {
  const env = c.env;
  const now = new Date();
  const since30 = utcDay(new Date(now.getTime() - 29 * 24 * 3600_000));
  const monthStart = `${utcDay(now).slice(0, 7)}-01`;
  const [storage, uploading, uploadedThisMonth, mediaRequests30, mediaBytes30, buffer30, bufferToday, rateLimit, channels] = await Promise.all([
    first<{ n: number; bytes: number | null }>(env.DB, `SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM media_assets WHERE status = 'ready'`),
    first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM media_assets WHERE status = 'uploading'`),
    first<{ n: number; bytes: number | null }>(
      env.DB,
      `SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM media_assets WHERE created_at >= ? AND status IN ('ready', 'deleted')`,
      monthStart,
    ),
    sumUsage(env.DB, 'media_requests', since30),
    sumUsage(env.DB, 'media_bytes', since30),
    sumUsage(env.DB, 'buffer_requests', since30),
    first<{ v: number }>(env.DB, `SELECT value AS v FROM usage_daily WHERE day = ? AND metric = 'buffer_requests'`, utcDay(now)),
    getState<RateLimitSnapshot>(env, 'buffer_rate_limit'),
    first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM social_channels WHERE provider = 'buffer' AND enabled = 1`),
  ]);
  const settings = await getSettings(env);
  const storedGB = (storage?.bytes ?? 0) / GB;
  const partsThisMonth = Math.ceil((uploadedThisMonth?.bytes ?? 0) / (20 * 1024 * 1024)) + (uploadedThisMonth?.n ?? 0) * 2;
  const classB30 = mediaRequests30 * 2;
  const storageCost = Math.max(0, storedGB - R2_PRICING.free.storageGB) * R2_PRICING.storagePerGBMonth;
  const classACost = Math.max(0, partsThisMonth - R2_PRICING.free.classA) / 1e6 * R2_PRICING.classAPerMillion;
  const classBCost = Math.max(0, classB30 - R2_PRICING.free.classB) / 1e6 * R2_PRICING.classBPerMillion;
  const bufferChannels = channels?.n ?? 0;
  const buffer30Limit = Math.min(BUFFER_LIMITS.free.per30DaysMax, Math.max(1, bufferChannels) * BUFFER_LIMITS.free.per30DaysPerChannel);

  const warnings: string[] = [];
  if (storedGB > R2_PRICING.free.storageGB * 0.8) {
    warnings.push(`Armazenamento em ${storedGB.toFixed(2)} GB, perto da franquia de ${R2_PRICING.free.storageGB} GB do R2. Use a limpeza de mídia antiga.`);
  }
  if (buffer30 > buffer30Limit * 0.8) warnings.push('Uso da API do Buffer nos últimos 30 dias perto do limite do plano Free.');
  if ((uploading?.n ?? 0) > 0) warnings.push(`${uploading?.n} envio(s) incompleto(s) ocupando registro. Cancele-os na Biblioteca.`);

  return c.json({
    storage: {
      assets: storage?.n ?? 0,
      bytes: storage?.bytes ?? 0,
      gb: storedGB,
      uploading: uploading?.n ?? 0,
      uploadedThisMonth: { count: uploadedThisMonth?.n ?? 0, bytes: uploadedThisMonth?.bytes ?? 0 },
    },
    r2: {
      pricing: R2_PRICING,
      estimates: {
        storageGBMonth: storedGB,
        classAThisMonth: partsThisMonth,
        classBLast30Days: classB30,
        egressBytesLast30Days: mediaBytes30,
        costUsd: { storage: storageCost, classA: classACost, classB: classBCost, total: storageCost + classACost + classBCost },
      },
    },
    buffer: {
      limits: BUFFER_LIMITS,
      channels: bufferChannels,
      requestsToday: bufferToday?.v ?? 0,
      requestsLast30Days: buffer30,
      limit30Days: buffer30Limit,
      dailyBudget: settings.dailyBufferBudget,
      lastRateLimit: rateLimit,
      intervalMinutes: settings.schedulerIntervalMinutes,
    },
    workers: {
      freeRequestsPerDay: 100_000,
      mediaRequestsLast30Days: mediaRequests30,
      cronInvocationsPerDay: 96,
      notes: [
        'Cada disparo do cron conta como uma invocação do Worker (96 por dia com o cron a cada 15 minutos).',
        'Cada pedido de vídeo do Buffer ou do painel (inclusive pedaços via Range) conta como uma requisição.',
      ],
    },
    d1: { freeStorageGB: 5, freeRowsReadPerDay: 5_000_000, freeRowsWrittenPerDay: 100_000 },
    warnings,
  });
});

admin.get('/settings', async (c) => {
  const settings = await getSettings(c.env);
  const origin = new URL(c.req.url).origin;
  const token = await icsToken(c.env);
  const base = publicBaseUrl(c.env, await getState<string>(c.env, 'public_origin')) ?? origin;
  return c.json({
    settings,
    environment: {
      bufferConfigured: isBufferConfigured(c.env),
      directUploadConfigured: canPresign(c.env),
      maxUploadBytes: maxUploadBytes(c.env),
      publicBaseUrl: publicBaseUrl(c.env, await getState<string>(c.env, 'public_origin')),
      publicBaseUrlFromEnv: Boolean(c.env.PUBLIC_BASE_URL),
    },
    kwaiCalendarUrl: `${base}/feeds/kwai/${token}.ics`,
  });
});

admin.patch('/settings', async (c) => {
  const patch = parseWith(settingsPatchSchema, await readJson(c.req.raw));
  return c.json({ settings: await saveSettings(c.env, patch) });
});

admin.post('/settings/ics-token/rotate', async (c) => {
  const token = randomToken(24);
  await setState(c.env, 'ics_token', token);
  return c.json({ ok: true });
});

// ---------- Redes ----------

admin.get('/channels', async (c) => {
  await ensureKwaiChannel(c.env);
  const settings = await getSettings(c.env);
  return c.json({
    bufferConfigured: isBufferConfigured(c.env),
    organizationId: settings.bufferOrganizationId,
    channels: await listChannels(c.env),
  });
});

admin.post('/buffer/test', async (c) => c.json(await testConnection(c.env)));

admin.post('/buffer/organization', async (c) => {
  const { organizationId } = parseWith(z.object({ organizationId: z.string().min(1).max(100) }), await readJson(c.req.raw));
  await selectOrganization(c.env, organizationId);
  return c.json({ ok: true });
});

admin.post('/buffer/sync-channels', async (c) => c.json(await syncChannels(c.env)));

admin.post('/buffer/map-channel', async (c) => {
  const body = parseWith(z.object({ platform: z.enum(BUFFER_PLATFORMS), externalId: z.string().min(1).max(100) }), await readJson(c.req.raw));
  await mapChannel(c.env, body.platform, body.externalId);
  return c.json({ ok: true });
});

admin.patch('/channels/:id', async (c) => {
  const id = parseWith(z.coerce.number().int().positive(), c.req.param('id'));
  const body = parseWith(
    z.object({ enabled: z.boolean().optional(), queueLimit: z.number().int().min(0).max(1000).optional() }),
    await readJson(c.req.raw),
  );
  const ch = await first<{ id: number; enabled: number; queue_limit: number }>(c.env.DB, 'SELECT id, enabled, queue_limit FROM social_channels WHERE id = ?', id);
  if (!ch) throw notFound('Canal não encontrado.');
  await run(
    c.env.DB,
    'UPDATE social_channels SET enabled = ?, queue_limit = ?, updated_at = ? WHERE id = ?',
    body.enabled === undefined ? ch.enabled : body.enabled ? 1 : 0,
    body.queueLimit ?? ch.queue_limit,
    nowIso(),
    id,
  );
  return c.json({ ok: true });
});

export default admin;
