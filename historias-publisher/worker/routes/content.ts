import { Hono } from 'hono';
import { z } from 'zod';
import { composeCaption, validateCaption } from '../../shared/captions';
import { PLATFORMS, type Platform } from '../../shared/constants';
import { slugify } from '../../shared/filename';
import { all, chunk, first, nowIso, placeholders, run } from '../lib/db';
import { badRequest, conflict, notFound, parseWith, readJson } from '../lib/http';
import { mediaPath } from '../services/media';
import type { AppEnv } from './types';

const content = new Hono<AppEnv>();

const platformEnum = z.enum(PLATFORMS);
const idParam = z.coerce.number().int().positive();

// ---------- Séries ----------

interface SeriesRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  default_hashtags: string;
  position: number;
  episode_count: number;
}

content.get('/series', async (c) => {
  const rows = await all<SeriesRow>(
    c.env.DB,
    `SELECT s.*, (SELECT COUNT(*) FROM episodes e WHERE e.series_id = s.id) AS episode_count
     FROM series s ORDER BY s.position ASC, s.id ASC`,
  );
  return c.json({ series: rows });
});

const seriesInput = z.object({
  title: z.string().trim().min(1, 'informe o nome').max(120),
  description: z.string().max(2000).optional(),
  defaultHashtags: z.string().max(500).optional(),
  position: z.number().int().min(0).max(100000).optional(),
});

async function createSeries(db: D1Database, title: string, extra: { description?: string; defaultHashtags?: string } = {}): Promise<number> {
  const slugBase = slugify(title) || 'serie';
  let slug = slugBase;
  for (let i = 2; await first(db, `SELECT 1 FROM series WHERE profile_id = 'default' AND slug = ?`, slug); i++) slug = `${slugBase}-${i}`;
  const pos = await first<{ p: number | null }>(db, 'SELECT MAX(position) AS p FROM series');
  const now = nowIso();
  const row = await first<{ id: number }>(
    db,
    `INSERT INTO series (slug, title, description, default_hashtags, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    slug,
    title,
    extra.description ?? '',
    extra.defaultHashtags ?? '',
    (pos?.p ?? -1) + 1,
    now,
    now,
  );
  return row!.id;
}

content.post('/series', async (c) => {
  const body = parseWith(seriesInput, await readJson(c.req.raw));
  const id = await createSeries(c.env.DB, body.title, body);
  return c.json({ id }, 201);
});

content.patch('/series/:id', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const body = parseWith(seriesInput.partial(), await readJson(c.req.raw));
  const current = await first<SeriesRow>(c.env.DB, 'SELECT * FROM series WHERE id = ?', id);
  if (!current) throw notFound('Série não encontrada.');
  await run(
    c.env.DB,
    `UPDATE series SET title = ?, description = ?, default_hashtags = ?, position = ?, updated_at = ? WHERE id = ?`,
    body.title ?? current.title,
    body.description ?? current.description,
    body.defaultHashtags ?? current.default_hashtags,
    body.position ?? current.position,
    nowIso(),
    id,
  );
  return c.json({ ok: true });
});

content.delete('/series/:id', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const used = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM episodes WHERE series_id = ?', id);
  if ((used?.n ?? 0) > 0) throw conflict('Mova ou exclua os episódios desta série antes de excluí-la.');
  await run(c.env.DB, 'DELETE FROM series WHERE id = ?', id);
  return c.json({ ok: true });
});

// ---------- Episódios ----------

interface EpisodeRow {
  id: number;
  series_id: number;
  series_title: string;
  series_hashtags: string;
  episode_number: number;
  title: string;
  description: string;
  media_asset_id: string | null;
  caption_mode: 'shared' | 'custom';
  shared_caption: string;
  shared_hashtags: string;
  created_at: string;
  updated_at: string;
  m_status: string | null;
  m_filename: string | null;
  m_size: number | null;
  m_token: string | null;
  m_key: string | null;
  m_duration_ms: number | null;
  m_width: number | null;
  m_height: number | null;
}

interface PlatformRow {
  episode_id: number;
  platform: Platform;
  enabled: number;
  caption: string | null;
  hashtags: string | null;
  title: string | null;
}

interface JobSummaryRow {
  id: number;
  episode_id: number;
  platform: Platform;
  state: string;
  scheduled_at: string;
  buffer_post_id: string | null;
  last_error: string | null;
  attention_reason: string | null;
}

const EPISODE_SELECT = `
SELECT e.*, s.title AS series_title, s.default_hashtags AS series_hashtags,
       m.status AS m_status, m.original_filename AS m_filename, m.size_bytes AS m_size, m.public_token AS m_token, m.r2_key AS m_key,
       m.duration_ms AS m_duration_ms, m.width AS m_width, m.height AS m_height
FROM episodes e JOIN series s ON s.id = e.series_id LEFT JOIN media_assets m ON m.id = e.media_asset_id`;

function shapeEpisode(e: EpisodeRow, platforms: PlatformRow[], jobs: JobSummaryRow[]) {
  const byPlatform = Object.fromEntries(
    PLATFORMS.map((p) => {
      const row = platforms.find((r) => r.platform === p);
      return [p, { enabled: row ? row.enabled === 1 : true, caption: row?.caption ?? null, hashtags: row?.hashtags ?? null, title: row?.title ?? null }];
    }),
  ) as Record<Platform, { enabled: boolean; caption: string | null; hashtags: string | null; title: string | null }>;
  const previews = {} as Record<Platform, string>;
  const issues: { platform: Platform; message: string }[] = [];
  for (const p of PLATFORMS) {
    previews[p] = composeCaption({
      captionMode: e.caption_mode,
      sharedCaption: e.shared_caption,
      sharedHashtags: e.shared_hashtags,
      seriesHashtags: e.series_hashtags,
      platformCaption: byPlatform[p].caption,
      platformHashtags: byPlatform[p].hashtags,
    });
    if (byPlatform[p].enabled) issues.push(...validateCaption(p, previews[p], p === 'youtube' ? byPlatform[p].title || e.title : null));
  }
  if (!e.media_asset_id || e.m_status !== 'ready') issues.push({ platform: 'instagram', message: 'Sem vídeo pronto vinculado.' });
  return {
    id: e.id,
    seriesId: e.series_id,
    seriesTitle: e.series_title,
    episodeNumber: e.episode_number,
    title: e.title,
    description: e.description,
    captionMode: e.caption_mode,
    sharedCaption: e.shared_caption,
    sharedHashtags: e.shared_hashtags,
    seriesHashtags: e.series_hashtags,
    media: e.media_asset_id
      ? {
          id: e.media_asset_id,
          status: e.m_status,
          filename: e.m_filename,
          sizeBytes: e.m_size,
          durationMs: e.m_duration_ms,
          width: e.m_width,
          height: e.m_height,
          path: e.m_token && e.m_key && e.m_status === 'ready' ? mediaPath({ id: e.media_asset_id, public_token: e.m_token, r2_key: e.m_key }) : null,
        }
      : null,
    platforms: byPlatform,
    previews,
    issues,
    jobs: jobs.map((j) => ({
      id: j.id,
      platform: j.platform,
      state: j.state,
      scheduledAt: j.scheduled_at,
      bufferPostId: j.buffer_post_id,
      lastError: j.last_error,
      attentionReason: j.attention_reason,
    })),
    updatedAt: e.updated_at,
  };
}

async function loadEpisodes(db: D1Database, where: string, params: unknown[]) {
  // As consultas auxiliares repetem o mesmo filtro em vez de usar IN (...): o D1 aceita no máximo 100 parâmetros por consulta.
  const [rows, platforms, jobs] = await Promise.all([
    all<EpisodeRow>(db, `${EPISODE_SELECT} ${where} ORDER BY s.position ASC, s.id ASC, e.episode_number ASC`, ...params),
    all<PlatformRow>(db, `SELECT ep.* FROM episode_platforms ep JOIN episodes e ON e.id = ep.episode_id ${where}`, ...params),
    all<JobSummaryRow>(
      db,
      `SELECT j.id, j.episode_id, j.platform, j.state, j.scheduled_at, j.buffer_post_id, j.last_error, j.attention_reason
       FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id
       ${where ? `${where} AND` : 'WHERE'} j.state <> 'cancelled' ORDER BY j.scheduled_at`,
      ...params,
    ),
  ]);
  return rows.map((r) =>
    shapeEpisode(
      r,
      platforms.filter((p) => p.episode_id === r.id),
      jobs.filter((j) => j.episode_id === r.id),
    ),
  );
}

content.get('/episodes', async (c) => {
  const seriesId = c.req.query('series');
  const where = seriesId ? 'WHERE e.series_id = ?' : '';
  const params = seriesId ? [parseWith(idParam, seriesId)] : [];
  // D1 limita variáveis por consulta; com centenas de episódios, a listagem é paginada no navegador.
  return c.json({ episodes: await loadEpisodes(c.env.DB, where, params) });
});

content.get('/episodes/:id', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const [episode] = await loadEpisodes(c.env.DB, 'WHERE e.id = ?', [id]);
  if (!episode) throw notFound('Episódio não encontrado.');
  return c.json({ episode });
});

const platformPatch = z.object({
  enabled: z.boolean().optional(),
  caption: z.string().max(5000).nullable().optional(),
  hashtags: z.string().max(1000).nullable().optional(),
  title: z.string().max(100).nullable().optional(),
});

const episodePatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  seriesId: z.number().int().positive().optional(),
  episodeNumber: z.number().int().positive().max(100000).optional(),
  mediaAssetId: z.string().uuid().nullable().optional(),
  captionMode: z.enum(['shared', 'custom']).optional(),
  sharedCaption: z.string().max(5000).optional(),
  sharedHashtags: z.string().max(1000).optional(),
  platforms: z.partialRecord(platformEnum, platformPatch).optional(),
});

function platformStatements(db: D1Database, episodeId: number, platforms: z.infer<typeof episodePatch>['platforms']): D1PreparedStatement[] {
  if (!platforms) return [];
  const out: D1PreparedStatement[] = [];
  for (const [platform, p] of Object.entries(platforms)) {
    if (!p) continue;
    out.push(
      db
        .prepare(
          `INSERT INTO episode_platforms (episode_id, platform, enabled, caption, hashtags, title) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (episode_id, platform) DO UPDATE SET
             enabled = CASE WHEN ? IS NULL THEN episode_platforms.enabled ELSE excluded.enabled END,
             caption = CASE WHEN ? THEN excluded.caption ELSE episode_platforms.caption END,
             hashtags = CASE WHEN ? THEN excluded.hashtags ELSE episode_platforms.hashtags END,
             title = CASE WHEN ? THEN excluded.title ELSE episode_platforms.title END`,
        )
        .bind(
          episodeId,
          platform,
          p.enabled === undefined ? 1 : p.enabled ? 1 : 0,
          p.caption ?? null,
          p.hashtags ?? null,
          p.title ?? null,
          p.enabled === undefined ? null : 1,
          p.caption !== undefined ? 1 : 0,
          p.hashtags !== undefined ? 1 : 0,
          p.title !== undefined ? 1 : 0,
        ),
    );
  }
  return out;
}

async function assertMediaUsable(db: D1Database, mediaAssetId: string | null | undefined): Promise<void> {
  if (!mediaAssetId) return;
  const m = await first<{ status: string }>(db, 'SELECT status FROM media_assets WHERE id = ?', mediaAssetId);
  if (!m || m.status !== 'ready') throw badRequest('Vídeo inexistente ou ainda não enviado por completo.');
}

const episodeCreate = episodePatch.extend({
  title: z.string().trim().min(1).max(200),
  episodeNumber: z.number().int().positive().max(100000),
  seriesId: z.number().int().positive().optional(),
  seriesTitle: z.string().trim().min(1).max(120).optional(),
});

content.post('/episodes', async (c) => {
  const body = parseWith(episodeCreate, await readJson(c.req.raw));
  const seriesId = body.seriesId ?? (body.seriesTitle ? await createSeries(c.env.DB, body.seriesTitle) : null);
  if (!seriesId) throw badRequest('Informe a série.');
  await assertMediaUsable(c.env.DB, body.mediaAssetId);
  const now = nowIso();
  try {
    const row = await first<{ id: number }>(
      c.env.DB,
      `INSERT INTO episodes (series_id, episode_number, title, description, media_asset_id, caption_mode, shared_caption, shared_hashtags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      seriesId,
      body.episodeNumber,
      body.title,
      body.description ?? '',
      body.mediaAssetId ?? null,
      body.captionMode ?? 'shared',
      body.sharedCaption ?? '',
      body.sharedHashtags ?? '',
      now,
      now,
    );
    const stmts = platformStatements(c.env.DB, row!.id, body.platforms);
    if (stmts.length) await c.env.DB.batch(stmts);
    return c.json({ id: row!.id }, 201);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw conflict('Já existe um episódio com esse número nesta série.');
    throw e;
  }
});

content.patch('/episodes/:id', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const body = parseWith(episodePatch, await readJson(c.req.raw));
  const current = await first<EpisodeRow>(c.env.DB, `${EPISODE_SELECT} WHERE e.id = ?`, id);
  if (!current) throw notFound('Episódio não encontrado.');
  if (body.mediaAssetId !== undefined) await assertMediaUsable(c.env.DB, body.mediaAssetId);
  if (body.mediaAssetId !== undefined && body.mediaAssetId !== current.media_asset_id) {
    const live = await first<{ n: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM publication_jobs WHERE episode_id = ? AND state IN ('creating', 'scheduled_buffer')`,
      id,
    );
    if ((live?.n ?? 0) > 0) throw conflict('Este episódio já está agendado no Buffer com o vídeo atual. Cancele essas publicações para trocar o vídeo.');
  }
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE episodes SET title = ?, description = ?, series_id = ?, episode_number = ?, media_asset_id = ?, caption_mode = ?,
         shared_caption = ?, shared_hashtags = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      body.title ?? current.title,
      body.description ?? current.description,
      body.seriesId ?? current.series_id,
      body.episodeNumber ?? current.episode_number,
      body.mediaAssetId === undefined ? current.media_asset_id : body.mediaAssetId,
      body.captionMode ?? current.caption_mode,
      body.sharedCaption ?? current.shared_caption,
      body.sharedHashtags ?? current.shared_hashtags,
      nowIso(),
      id,
    ),
    ...platformStatements(c.env.DB, id, body.platforms),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw conflict('Já existe um episódio com esse número nesta série.');
    throw e;
  }
  const [episode] = await loadEpisodes(c.env.DB, 'WHERE e.id = ?', [id]);
  const lockedInBuffer = episode?.jobs.some((j) => j.state === 'scheduled_buffer') ?? false;
  return c.json({
    episode,
    notice: lockedInBuffer
      ? 'Publicações já agendadas no Buffer mantêm o texto enviado. Para aplicar a nova legenda nelas, cancele e reagende.'
      : null,
  });
});

const batchInput = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  patch: z.object({
    seriesId: z.number().int().positive().optional(),
    captionMode: z.enum(['shared', 'custom']).optional(),
    sharedCaption: z.string().max(5000).optional(),
    sharedHashtags: z.string().max(1000).optional(),
    appendHashtags: z.string().max(500).optional(),
    platformsEnabled: z.partialRecord(platformEnum, z.boolean()).optional(),
  }),
});

content.post('/episodes/batch', async (c) => {
  const { ids, patch } = parseWith(batchInput, await readJson(c.req.raw));
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  if (patch.seriesId) {
    const s = await first(c.env.DB, 'SELECT 1 FROM series WHERE id = ?', patch.seriesId);
    if (!s) throw notFound('Série não encontrada.');
  }
  for (const group of chunk(ids, 80)) {
    const ph = placeholders(group.length);
    if (patch.seriesId) {
      stmts.push(c.env.DB.prepare(`UPDATE episodes SET series_id = ?, updated_at = ? WHERE id IN (${ph})`).bind(patch.seriesId, now, ...group));
    }
    if (patch.captionMode) {
      stmts.push(c.env.DB.prepare(`UPDATE episodes SET caption_mode = ?, updated_at = ? WHERE id IN (${ph})`).bind(patch.captionMode, now, ...group));
    }
    if (patch.sharedCaption !== undefined) {
      stmts.push(c.env.DB.prepare(`UPDATE episodes SET shared_caption = ?, updated_at = ? WHERE id IN (${ph})`).bind(patch.sharedCaption, now, ...group));
    }
    if (patch.sharedHashtags !== undefined) {
      stmts.push(c.env.DB.prepare(`UPDATE episodes SET shared_hashtags = ?, updated_at = ? WHERE id IN (${ph})`).bind(patch.sharedHashtags, now, ...group));
    }
    if (patch.appendHashtags) {
      stmts.push(
        c.env.DB.prepare(`UPDATE episodes SET shared_hashtags = TRIM(shared_hashtags || ' ' || ?), updated_at = ? WHERE id IN (${ph})`).bind(
          patch.appendHashtags,
          now,
          ...group,
        ),
      );
    }
  }
  for (const [platform, enabled] of Object.entries(patch.platformsEnabled ?? {})) {
    for (const id of ids) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO episode_platforms (episode_id, platform, enabled) VALUES (?, ?, ?)
           ON CONFLICT (episode_id, platform) DO UPDATE SET enabled = excluded.enabled`,
        ).bind(id, platform, enabled ? 1 : 0),
      );
    }
  }
  if (stmts.length === 0) throw badRequest('Nada para alterar.');
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw conflict('Mover para essa série criaria números de episódio repetidos.');
    throw e;
  }
  return c.json({ updated: ids.length });
});

content.delete('/episodes/:id', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const active = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM publication_jobs WHERE episode_id = ? AND state <> 'cancelled'`, id);
  if ((active?.n ?? 0) > 0) throw conflict('Cancele as publicações deste episódio antes de excluí-lo.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM publication_jobs WHERE episode_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM episodes WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// Importação: cria séries e episódios a partir dos vídeos enviados.
const importInput = z.object({
  items: z
    .array(
      z.object({
        assetId: z.string().uuid(),
        seriesName: z.string().trim().min(1).max(120),
        episodeNumber: z.number().int().positive().max(100000),
        title: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(200),
});

content.post('/episodes/import', async (c) => {
  const { items } = parseWith(importInput, await readJson(c.req.raw));
  const db = c.env.DB;
  // Poucas consultas no total (o plano Free do Workers permite 50 por requisição).
  const assets = await all<{ id: string; status: string }>(db, `SELECT id, status FROM media_assets WHERE status = 'ready'`);
  const ready = new Set(assets.map((a) => a.id));
  let seriesRows = await all<{ id: number; slug: string }>(db, `SELECT id, slug FROM series WHERE profile_id = 'default'`);
  const now = nowIso();

  const wantedSlugs = new Map<string, string>();
  for (const item of items) {
    const slug = slugify(item.seriesName) || 'serie';
    if (!wantedSlugs.has(slug)) wantedSlugs.set(slug, item.seriesName);
  }
  const missing = [...wantedSlugs].filter(([slug]) => !seriesRows.some((s) => s.slug === slug));
  if (missing.length > 0) {
    const pos = await first<{ p: number | null }>(db, 'SELECT MAX(position) AS p FROM series');
    let next = (pos?.p ?? -1) + 1;
    await db.batch(
      missing.map(([slug, title]) =>
        db
          .prepare(`INSERT OR IGNORE INTO series (slug, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(slug, title, next++, now, now),
      ),
    );
    seriesRows = await all<{ id: number; slug: string }>(db, `SELECT id, slug FROM series WHERE profile_id = 'default'`);
  }
  const seriesBySlug = new Map(seriesRows.map((s) => [s.slug, s.id]));
  const existing = await all<{ id: number; series_id: number; episode_number: number; media_asset_id: string | null }>(
    db,
    'SELECT id, series_id, episode_number, media_asset_id FROM episodes',
  );
  const existingKey = new Map(existing.map((e) => [`${e.series_id}:${e.episode_number}`, e]));
  const usedAssets = new Set(existing.map((e) => e.media_asset_id).filter(Boolean));

  const result = { created: 0, attached: 0, skipped: [] as { assetId: string; reason: string }[] };
  const stmts: D1PreparedStatement[] = [];
  for (const item of items) {
    if (!ready.has(item.assetId)) {
      result.skipped.push({ assetId: item.assetId, reason: 'Vídeo não encontrado ou envio incompleto.' });
      continue;
    }
    if (usedAssets.has(item.assetId)) {
      result.skipped.push({ assetId: item.assetId, reason: 'Este vídeo já está vinculado a um episódio.' });
      continue;
    }
    const seriesId = seriesBySlug.get(slugify(item.seriesName) || 'serie')!;
    const key = `${seriesId}:${item.episodeNumber}`;
    const ep = existingKey.get(key);
    if (ep) {
      if (ep.media_asset_id) {
        result.skipped.push({ assetId: item.assetId, reason: `Episódio ${item.episodeNumber} de "${item.seriesName}" já tem vídeo.` });
      } else {
        stmts.push(db.prepare('UPDATE episodes SET media_asset_id = ?, updated_at = ? WHERE id = ?').bind(item.assetId, now, ep.id));
        ep.media_asset_id = item.assetId;
        result.attached++;
      }
      continue;
    }
    stmts.push(
      db
        .prepare(`INSERT INTO episodes (series_id, episode_number, title, media_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(seriesId, item.episodeNumber, item.title ?? `${item.seriesName} · Episódio ${item.episodeNumber}`, item.assetId, now, now),
    );
    existingKey.set(key, { id: -1, series_id: seriesId, episode_number: item.episodeNumber, media_asset_id: item.assetId });
    usedAssets.add(item.assetId);
    result.created++;
  }
  if (stmts.length) await db.batch(stmts);
  return c.json(result);
});

export default content;
