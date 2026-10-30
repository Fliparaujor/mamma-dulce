import { all, nowIso } from '../lib/db';
import type { Settings } from '../settings';
import type { Env } from '../env';

export interface CleanupCandidate {
  id: string;
  original_filename: string;
  size_bytes: number;
  r2_key: string;
  last_published_at: string | null;
  reason: string;
}

/**
 * Mídias que podem ser apagadas com segurança:
 * - nenhuma publicação ativa depende delas (só publicadas ou canceladas), e
 * - a última publicação (ou o envio, se nunca foi usada) é mais antiga que o período de retenção.
 * Vídeos com publicação futura nunca entram na lista.
 */
export async function cleanupCandidates(env: Env, settings: Settings, now: Date, limit = 100): Promise<CleanupCandidate[]> {
  const cutoff = new Date(now.getTime() - settings.mediaRetentionDays * 24 * 3600_000).toISOString();
  return all<CleanupCandidate>(
    env.DB,
    `SELECT m.id, m.original_filename, m.size_bytes, m.r2_key,
            (SELECT MAX(j.published_at) FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id WHERE e.media_asset_id = m.id) AS last_published_at,
            CASE WHEN EXISTS (SELECT 1 FROM episodes e WHERE e.media_asset_id = m.id) THEN 'published' ELSE 'unused' END AS reason
     FROM media_assets m
     WHERE m.status = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id
         WHERE e.media_asset_id = m.id AND j.state NOT IN ('published', 'cancelled'))
       AND (
         (EXISTS (SELECT 1 FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id WHERE e.media_asset_id = m.id AND j.state = 'published')
          AND (SELECT MAX(j.published_at) FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id WHERE e.media_asset_id = m.id) < ?)
         OR (NOT EXISTS (SELECT 1 FROM episodes e WHERE e.media_asset_id = m.id) AND m.uploaded_at < ?)
       )
     ORDER BY m.uploaded_at ASC
     LIMIT ?`,
    cutoff,
    cutoff,
    limit,
  );
}

export async function runMediaCleanup(
  env: Env,
  settings: Settings,
  now: Date,
  opts: { dryRun: boolean; limit: number },
): Promise<{ deleted: number; bytes: number; candidates?: CleanupCandidate[] }> {
  const candidates = await cleanupCandidates(env, settings, now, opts.limit);
  if (opts.dryRun) {
    return { deleted: 0, bytes: candidates.reduce((a, c) => a + c.size_bytes, 0), candidates };
  }
  let bytes = 0;
  let deleted = 0;
  const stamp = nowIso(now);
  for (const c of candidates) {
    // Reconfere logo antes de apagar (pode ter sido reagendado entre a consulta e agora).
    const still = await all<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id
       WHERE e.media_asset_id = ? AND j.state NOT IN ('published', 'cancelled')`,
      c.id,
    );
    if ((still[0]?.n ?? 0) > 0) continue;
    await env.MEDIA.delete(c.r2_key);
    await env.DB.prepare(`UPDATE media_assets SET status = 'deleted', deleted_at = ? WHERE id = ? AND status = 'ready'`).bind(stamp, c.id).run();
    bytes += c.size_bytes;
    deleted++;
  }
  return { deleted, bytes };
}
