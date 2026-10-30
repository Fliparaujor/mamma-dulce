import { composeCaption, validateCaption } from '../../shared/captions';
import type { JobState, Platform } from '../../shared/constants';
import type { CreatePostInput } from '../buffer/api';
import type { Settings } from '../settings';

export interface JobRow {
  id: number;
  episode_id: number;
  platform: Platform;
  channel_id: number | null;
  scheduled_at: string;
  state: JobState;
  buffer_post_id: string | null;
  buffer_status: string | null;
  buffer_scheduling_type: string | null;
  buffer_due_at: string | null;
  create_started_at: string | null;
  published_at: string | null;
  external_url: string | null;
  attention_reason: string | null;
  last_error: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  manual_confirmed_at: string | null;
}

/** Linha de publicação com tudo que é necessário para montar o post. */
export interface JobForPublishing extends JobRow {
  episode_title: string;
  episode_number: number;
  series_title: string;
  caption_mode: 'shared' | 'custom';
  shared_caption: string;
  shared_hashtags: string;
  series_hashtags: string;
  p_enabled: number | null;
  p_caption: string | null;
  p_hashtags: string | null;
  p_title: string | null;
  m_id: string | null;
  m_status: string | null;
  m_token: string | null;
  m_key: string | null;
  m_duration_ms: number | null;
  m_width: number | null;
  m_height: number | null;
}

export const JOB_FOR_PUBLISHING_SELECT = `
SELECT j.*, e.title AS episode_title, e.episode_number, s.title AS series_title,
       e.caption_mode, e.shared_caption, e.shared_hashtags, s.default_hashtags AS series_hashtags,
       ep.enabled AS p_enabled, ep.caption AS p_caption, ep.hashtags AS p_hashtags, ep.title AS p_title,
       m.id AS m_id, m.status AS m_status, m.public_token AS m_token, m.r2_key AS m_key,
       m.duration_ms AS m_duration_ms, m.width AS m_width, m.height AS m_height
FROM publication_jobs j
JOIN episodes e ON e.id = j.episode_id
JOIN series s ON s.id = e.series_id
LEFT JOIN episode_platforms ep ON ep.episode_id = e.id AND ep.platform = j.platform
LEFT JOIN media_assets m ON m.id = e.media_asset_id`;

export function jobCaption(job: JobForPublishing): string {
  return composeCaption({
    captionMode: job.caption_mode,
    sharedCaption: job.shared_caption,
    sharedHashtags: job.shared_hashtags,
    seriesHashtags: job.series_hashtags,
    platformCaption: job.p_caption,
    platformHashtags: job.p_hashtags,
  });
}

export function youtubeTitle(job: JobForPublishing): string {
  return (job.p_title?.trim() || job.episode_title).trim();
}

/** Problemas que impedem o envio (não adianta tentar de novo sem o usuário corrigir). */
export function publishingProblems(job: JobForPublishing, mediaUrl: string | null): string[] {
  const problems: string[] = [];
  if (!job.m_id) problems.push('Episódio sem vídeo vinculado.');
  else if (job.m_status !== 'ready') problems.push('O vídeo do episódio não está disponível (envio incompleto ou excluído).');
  if (!mediaUrl) {
    problems.push('URL pública do app não configurada (defina PUBLIC_BASE_URL com o endereço HTTPS do Worker).');
  }
  for (const issue of validateCaption(job.platform, jobCaption(job), job.platform === 'youtube' ? youtubeTitle(job) : null)) {
    problems.push(issue.message);
  }
  return problems;
}

/** Avisos que não bloqueiam (ex.: vídeo horizontal no YouTube não vira Short). */
export function publishingWarnings(job: JobForPublishing): string[] {
  const warnings: string[] = [];
  if (job.platform === 'youtube' && job.m_width && job.m_height && job.m_width > job.m_height) {
    warnings.push('Vídeo horizontal: o YouTube só trata como Short vídeos verticais ou quadrados.');
  }
  if (job.platform === 'youtube' && job.m_duration_ms && job.m_duration_ms > 180_000) {
    warnings.push('Vídeo com mais de 3 minutos: o YouTube não o classifica como Short.');
  }
  return warnings;
}

/** Monta o input de createPost conforme a referência oficial do Buffer. */
export function buildCreatePostInput(job: JobForPublishing, channelExternalId: string, mediaUrl: string, settings: Settings): CreatePostInput {
  const videoMeta: { thumbnailOffset?: number; title?: string } = {};
  if (settings.thumbnailOffsetMs != null && job.platform !== 'youtube') videoMeta.thumbnailOffset = settings.thumbnailOffsetMs;
  if (job.platform === 'youtube') videoMeta.title = youtubeTitle(job);

  const input: CreatePostInput = {
    channelId: channelExternalId,
    text: jobCaption(job),
    schedulingType: 'automatic',
    mode: 'customScheduled',
    dueAt: job.scheduled_at,
    assets: [{ video: { url: mediaUrl, ...(Object.keys(videoMeta).length ? { metadata: videoMeta } : {}) } }],
  };

  if (job.platform === 'instagram') {
    input.metadata = { instagram: { type: 'reel', shouldShareToFeed: settings.instagramShareToFeed } };
  } else if (job.platform === 'youtube') {
    input.metadata = {
      youtube: {
        title: youtubeTitle(job),
        categoryId: settings.youtubeCategoryId,
        privacy: settings.youtubePrivacy,
        madeForKids: settings.youtubeMadeForKids,
        notifySubscribers: settings.youtubeNotifySubscribers,
      },
    };
  }
  // TikTok: TikTokPostMetadataInput só tem isAiGenerated e title (este último para posts de foto). Nada a enviar.
  return input;
}

export function attemptStatement(
  db: D1Database,
  jobId: number,
  kind: string,
  outcome: 'success' | 'error' | 'unknown' | 'dry_run' | 'info',
  message: string | null,
  details: unknown,
  runId: number | null,
  now: Date,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO publication_attempts (job_id, scheduler_run_id, kind, outcome, message, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(jobId, runId, kind, outcome, message, details == null ? null : JSON.stringify(details), now.toISOString());
}

export function backoffMinutes(attempt: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempt - 1), 6 * 60);
}
