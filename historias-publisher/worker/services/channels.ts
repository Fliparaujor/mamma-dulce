import { BUFFER_PLATFORMS, DEFAULT_QUEUE_LIMIT, type BufferPlatform } from '../../shared/constants';
import type { BufferChannel, BufferOrganization } from '../buffer/api';
import { BufferError } from '../buffer/client';
import { createBufferSession } from '../buffer/factory';
import { all, first, nowIso, run } from '../lib/db';
import { badRequest, HttpError, notFound } from '../lib/http';
import { getSettings, saveSettings } from '../settings';
import type { Env } from '../env';

export interface ChannelRecord {
  id: number;
  platform: string;
  provider: 'buffer' | 'manual';
  external_id: string | null;
  organization_id: string | null;
  name: string;
  display_name: string | null;
  avatar_url: string | null;
  service: string | null;
  is_disconnected: number;
  is_locked: number;
  is_queue_paused: number;
  default_to_reminders: number | null;
  enabled: number;
  queue_limit: number;
  buffer_scheduled_count: number | null;
  last_synced_at: string | null;
}

function session(env: Env) {
  const s = createBufferSession(env, { maxRequests: 4 });
  if (!s) throw new HttpError(503, 'Defina o segredo BUFFER_API_KEY no Worker para conectar o Buffer.', 'buffer_not_configured');
  return s;
}

function toHttp(e: unknown): never {
  if (e instanceof BufferError) throw new HttpError(e.kind === 'rate_limited' ? 429 : 502, e.message, `buffer_${e.kind}`);
  throw e;
}

export async function testConnection(env: Env): Promise<{ organizations: BufferOrganization[] }> {
  const s = session(env);
  try {
    return { organizations: await s.api.organizations() };
  } catch (e) {
    toHttp(e);
  } finally {
    await s.flush();
  }
}

export async function selectOrganization(env: Env, organizationId: string): Promise<void> {
  const s = session(env);
  try {
    const orgs = await s.api.organizations();
    if (!orgs.some((o) => o.id === organizationId)) throw badRequest('Organização não encontrada nesta conta do Buffer.');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    toHttp(e);
  } finally {
    await s.flush();
  }
  await saveSettings(env, { bufferOrganizationId: organizationId });
}

function defaultToReminders(c: BufferChannel): number | null {
  const v = c.metadata?.defaultToReminders;
  return typeof v === 'boolean' ? (v ? 1 : 0) : null;
}

/**
 * Lê os canais da organização e mapeia Instagram, TikTok e YouTube.
 * Se houver mais de um canal da mesma rede, mantém o já mapeado; senão usa o primeiro.
 */
export async function syncChannels(env: Env, now = new Date()): Promise<{ channels: BufferChannel[]; mapped: Record<string, string | null> }> {
  const settings = await getSettings(env);
  if (!settings.bufferOrganizationId) throw badRequest('Escolha a organização do Buffer primeiro.');
  const s = session(env);
  let channels: BufferChannel[];
  try {
    channels = await s.api.channels(settings.bufferOrganizationId);
  } catch (e) {
    toHttp(e);
  } finally {
    await s.flush();
  }
  const existing = await all<ChannelRecord>(env.DB, `SELECT * FROM social_channels WHERE provider = 'buffer'`);
  const mapped: Record<string, string | null> = {};
  const nowS = nowIso(now);
  const stmts: D1PreparedStatement[] = [];
  for (const platform of BUFFER_PLATFORMS) {
    const current = existing.find((c) => c.platform === platform);
    const candidates = channels.filter((c) => c.service === platform);
    const chosen = candidates.find((c) => c.id === current?.external_id) ?? candidates[0];
    mapped[platform] = chosen?.id ?? null;
    if (!chosen) {
      if (current) {
        stmts.push(
          env.DB.prepare(`UPDATE social_channels SET is_disconnected = 1, updated_at = ? WHERE id = ?`).bind(nowS, current.id),
        );
      }
      continue;
    }
    stmts.push(upsertStatement(env, platform, chosen, settings.bufferOrganizationId, nowS));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { channels, mapped };
}

function upsertStatement(env: Env, platform: BufferPlatform, c: BufferChannel, orgId: string, nowS: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO social_channels (profile_id, platform, provider, external_id, organization_id, name, display_name, avatar_url, service,
       is_disconnected, is_locked, is_queue_paused, default_to_reminders, enabled, queue_limit, created_at, updated_at)
     VALUES ('default', ?, 'buffer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (profile_id, platform) DO UPDATE SET
       provider = 'buffer', external_id = excluded.external_id, organization_id = excluded.organization_id, name = excluded.name,
       display_name = excluded.display_name, avatar_url = excluded.avatar_url, service = excluded.service,
       is_disconnected = excluded.is_disconnected, is_locked = excluded.is_locked, is_queue_paused = excluded.is_queue_paused,
       default_to_reminders = excluded.default_to_reminders, updated_at = excluded.updated_at`,
  ).bind(
    platform,
    c.id,
    orgId,
    c.name,
    c.displayName,
    c.avatar,
    c.service,
    c.isDisconnected ? 1 : 0,
    c.isLocked ? 1 : 0,
    c.isQueuePaused ? 1 : 0,
    defaultToReminders(c),
    DEFAULT_QUEUE_LIMIT,
    nowS,
    nowS,
  );
}

/** Troca manualmente qual canal do Buffer representa uma rede. */
export async function mapChannel(env: Env, platform: BufferPlatform, externalId: string, now = new Date()): Promise<void> {
  const settings = await getSettings(env);
  if (!settings.bufferOrganizationId) throw badRequest('Escolha a organização do Buffer primeiro.');
  const s = session(env);
  let channels: BufferChannel[];
  try {
    channels = await s.api.channels(settings.bufferOrganizationId);
  } catch (e) {
    toHttp(e);
  } finally {
    await s.flush();
  }
  const chosen = channels.find((c) => c.id === externalId);
  if (!chosen) throw notFound('Canal não encontrado no Buffer.');
  if (chosen.service !== platform) throw badRequest(`Esse canal é do serviço "${chosen.service}", não de ${platform}.`);
  await upsertStatement(env, platform, chosen, settings.bufferOrganizationId, nowIso(now)).run();
}

export async function ensureKwaiChannel(env: Env, now = new Date()): Promise<number> {
  const row = await first<{ id: number }>(env.DB, `SELECT id FROM social_channels WHERE profile_id = 'default' AND platform = 'kwai'`);
  if (row) return row.id;
  const nowS = nowIso(now);
  await run(
    env.DB,
    `INSERT OR IGNORE INTO social_channels (profile_id, platform, provider, name, enabled, queue_limit, created_at, updated_at)
     VALUES ('default', 'kwai', 'manual', 'Kwai (publicação manual)', 1, 0, ?, ?)`,
    nowS,
    nowS,
  );
  const created = await first<{ id: number }>(env.DB, `SELECT id FROM social_channels WHERE profile_id = 'default' AND platform = 'kwai'`);
  return created!.id;
}

export async function listChannels(env: Env): Promise<ChannelRecord[]> {
  return all<ChannelRecord>(env.DB, `SELECT * FROM social_channels ORDER BY CASE platform WHEN 'instagram' THEN 1 WHEN 'tiktok' THEN 2 WHEN 'youtube' THEN 3 ELSE 4 END`);
}
