export const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'kwai'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Redes publicadas via Buffer. O Kwai fica fora: não há API oficial de publicação disponível para este caso. */
export const BUFFER_PLATFORMS = ['instagram', 'tiktok', 'youtube'] as const;
export type BufferPlatform = (typeof BUFFER_PLATFORMS)[number];

export function isBufferPlatform(p: string): p is BufferPlatform {
  return (BUFFER_PLATFORMS as readonly string[]).includes(p);
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: 'Instagram Reels',
  tiktok: 'TikTok',
  youtube: 'YouTube Shorts',
  kwai: 'Kwai',
};

export const JOB_STATES = [
  'planned',
  'creating',
  'scheduled_buffer',
  'manual_pending',
  'published',
  'failed',
  'needs_attention',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_STATE_LABEL: Record<JobState, string> = {
  planned: 'Planejado no sistema',
  creating: 'Enviando ao Buffer',
  scheduled_buffer: 'Agendado no Buffer',
  manual_pending: 'Ação manual necessária',
  published: 'Publicado',
  failed: 'Falhou',
  needs_attention: 'Requer atenção',
  cancelled: 'Cancelado',
};

/** Estados em que a publicação ainda pode acontecer (a mídia não pode ser apagada). */
export const ACTIVE_JOB_STATES: readonly JobState[] = [
  'planned',
  'creating',
  'scheduled_buffer',
  'manual_pending',
  'needs_attention',
  'failed',
];

export const TERMINAL_JOB_STATES: readonly JobState[] = ['published', 'cancelled'];

/** Limites de caracteres aplicados pelo Buffer (https://developers.buffer.com/guides/character-limits.html). */
export const CAPTION_LIMITS: Record<Platform, number> = {
  instagram: 2196,
  tiktok: 2200, // TikTok com vídeo anexado
  youtube: 5000, // descrição do vídeo
  kwai: 2200, // não documentado pelo Buffer; valor conservador para o fluxo manual
};
export const YOUTUBE_TITLE_LIMIT = 100;

/** Plano Free do Buffer: até 10 posts agendados por canal ao mesmo tempo. */
export const DEFAULT_QUEUE_LIMIT = 10;

export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const ACCEPTED_VIDEO_EXTENSIONS = ['.mp4', '.mov'] as const;

/** Partes de upload multipart (R2 exige no mínimo 5 MiB por parte, exceto a última). */
export const MULTIPART_THRESHOLD_BYTES = 95 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 20 * 1024 * 1024;

export const YOUTUBE_CATEGORIES: Record<string, string> = {
  '1': 'Filmes e animação',
  '22': 'Pessoas e blogs',
  '23': 'Comédia',
  '24': 'Entretenimento',
  '27': 'Educação',
};
