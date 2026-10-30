import { CAPTION_LIMITS, YOUTUBE_TITLE_LIMIT, type Platform } from './constants';

export interface CaptionSource {
  captionMode: 'shared' | 'custom';
  sharedCaption: string;
  sharedHashtags: string;
  seriesHashtags: string;
  platformCaption: string | null;
  platformHashtags: string | null;
}

/** Normaliza hashtags: aceita "a b #c, d" e devolve "#a #b #c #d" sem repetições. */
export function normalizeHashtags(input: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const tag = raw.replace(/^#+/, '').trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase('pt-BR');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${tag}`);
  }
  return out.join(' ');
}

/** Texto final enviado a uma rede: legenda + hashtags. */
export function composeCaption(src: CaptionSource): string {
  const useCustom = src.captionMode === 'custom';
  const caption = (useCustom && src.platformCaption != null && src.platformCaption.trim() !== ''
    ? src.platformCaption
    : src.sharedCaption
  ).trim();
  const hashtagsRaw = useCustom && src.platformHashtags != null && src.platformHashtags.trim() !== ''
    ? src.platformHashtags
    : [src.sharedHashtags, src.seriesHashtags].filter(Boolean).join(' ');
  const hashtags = normalizeHashtags(hashtagsRaw);
  return [caption, hashtags].filter(Boolean).join('\n\n');
}

/** Contagem em unidades UTF-16, igual à usada pelo Buffer para TikTok e YouTube. */
export function captionLength(text: string): number {
  return text.length;
}

export interface CaptionIssue {
  platform: Platform;
  message: string;
}

export function validateCaption(platform: Platform, text: string, youtubeTitle?: string | null): CaptionIssue[] {
  const issues: CaptionIssue[] = [];
  const limit = CAPTION_LIMITS[platform];
  if (captionLength(text) > limit) {
    issues.push({ platform, message: `Legenda com ${captionLength(text)} caracteres; o limite é ${limit}.` });
  }
  if (platform === 'youtube') {
    const title = (youtubeTitle ?? '').trim();
    if (!title) issues.push({ platform, message: 'O YouTube exige um título.' });
    else if (title.length > YOUTUBE_TITLE_LIMIT) {
      issues.push({ platform, message: `Título do YouTube com ${title.length} caracteres; o limite é ${YOUTUBE_TITLE_LIMIT}.` });
    }
  }
  return issues;
}
