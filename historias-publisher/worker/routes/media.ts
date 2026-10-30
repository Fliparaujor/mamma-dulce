import { Hono } from 'hono';
import { z } from 'zod';
import { ACCEPTED_VIDEO_TYPES } from '../../shared/constants';
import { all, first } from '../lib/db';
import { parseWith, readJson } from '../lib/http';
import { runMediaCleanup } from '../scheduler/cleanup';
import {
  abortUpload,
  activeDependents,
  canPresign,
  completeUpload,
  deleteAsset,
  findDuplicates,
  initUpload,
  maxUploadBytes,
  mediaPath,
  proxyBody,
  proxyPart,
  type MediaAssetRow,
} from '../services/media';
import { getSettings } from '../settings';
import type { AppEnv } from './types';

const media = new Hono<AppEnv>();

const assetId = z.string().uuid();

media.get('/media', async (c) => {
  const rows = await all<MediaAssetRow & { episode_id: number | null; episode_title: string | null; series_title: string | null; active_jobs: number }>(
    c.env.DB,
    `SELECT m.*, e.id AS episode_id, e.title AS episode_title, s.title AS series_title,
            (SELECT COUNT(*) FROM publication_jobs j WHERE j.episode_id = e.id AND j.state NOT IN ('published', 'cancelled')) AS active_jobs
     FROM media_assets m
     LEFT JOIN episodes e ON e.media_asset_id = m.id
     LEFT JOIN series s ON s.id = e.series_id
     WHERE m.status IN ('ready', 'uploading')
     ORDER BY m.created_at DESC
     LIMIT 500`,
  );
  return c.json({
    uploadMode: canPresign(c.env) ? 'direct' : 'worker',
    maxUploadBytes: maxUploadBytes(c.env),
    acceptedTypes: ACCEPTED_VIDEO_TYPES,
    assets: rows.map((r) => ({
      id: r.id,
      filename: r.original_filename,
      contentType: r.content_type,
      sizeBytes: r.size_bytes,
      durationMs: r.duration_ms,
      width: r.width,
      height: r.height,
      status: r.status,
      fingerprint: r.fingerprint,
      createdAt: r.created_at,
      uploadedAt: r.uploaded_at,
      path: r.status === 'ready' ? mediaPath(r) : null,
      episode: r.episode_id ? { id: r.episode_id, title: r.episode_title, seriesTitle: r.series_title } : null,
      activeJobs: r.active_jobs,
    })),
  });
});

const initInput = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().max(100),
  size: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{16,128}$/).nullable().optional(),
  durationMs: z.number().int().min(0).max(24 * 3600_000).nullable().optional(),
  width: z.number().int().min(0).max(20000).nullable().optional(),
  height: z.number().int().min(0).max(20000).nullable().optional(),
  allowDuplicate: z.boolean().optional(),
});

media.post('/uploads', async (c) => {
  const body = parseWith(initInput, await readJson(c.req.raw));
  const duplicates = await findDuplicates(c.env, body);
  if (duplicates.length > 0 && !body.allowDuplicate) {
    return c.json({ duplicate: true, duplicates }, 409);
  }
  const { assetId: id, plan } = await initUpload(c.env, body);
  return c.json({ assetId: id, plan, duplicates }, 201);
});

media.put('/uploads/:id/body', async (c) => {
  const id = parseWith(assetId, c.req.param('id'));
  await proxyBody(c.env, id, c.req.raw);
  return c.json({ ok: true });
});

media.put('/uploads/:id/parts/:n', async (c) => {
  const id = parseWith(assetId, c.req.param('id'));
  const n = parseWith(z.coerce.number().int().positive().max(10000), c.req.param('n'));
  const part = await proxyPart(c.env, id, n, c.req.raw);
  return c.json(part);
});

const completeInput = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1).max(200) })).max(10000).optional(),
});

media.post('/uploads/:id/complete', async (c) => {
  const id = parseWith(assetId, c.req.param('id'));
  const body = parseWith(completeInput, await readJson(c.req.raw));
  const asset = await completeUpload(c.env, id, body.parts);
  return c.json({ asset: { id: asset.id, status: asset.status, path: mediaPath(asset) } });
});

media.post('/uploads/:id/abort', async (c) => {
  const id = parseWith(assetId, c.req.param('id'));
  await abortUpload(c.env, id);
  return c.json({ ok: true });
});

media.delete('/media/:id', async (c) => {
  const id = parseWith(assetId, c.req.param('id'));
  await deleteAsset(c.env, id);
  return c.json({ ok: true });
});

media.get('/media/:id/dependents', async (c) => {
  const id = parseWith(assetId, c.req.param('id'));
  return c.json({ activeJobs: await activeDependents(c.env, id) });
});

const cleanupInput = z.object({ dryRun: z.boolean().default(true) });

media.post('/media/cleanup', async (c) => {
  const { dryRun } = parseWith(cleanupInput, await readJson(c.req.raw));
  const settings = await getSettings(c.env);
  const result = await runMediaCleanup(c.env, settings, new Date(), { dryRun, limit: dryRun ? 200 : 20 });
  const pending = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM media_assets WHERE status = 'uploading' AND created_at < ?`, new Date(Date.now() - 24 * 3600_000).toISOString());
  return c.json({ ...result, staleUploads: pending?.n ?? 0, retentionDays: settings.mediaRetentionDays });
});

export default media;
