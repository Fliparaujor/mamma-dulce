// Lê o arquivo de legendas de uma série. Cada episódio começa com um cabeçalho como
// "==== PARTE 1 — O ASSOBIO ====" ou "Episódio 2: A Vila". As linhas finais só com hashtags viram hashtags.
import { normalizeHashtags } from './captions';

export interface CaptionEntry {
  episodeNumber: number;
  subtitle: string;
  caption: string;
  hashtags: string;
}

const HEADER = /^[=\-\s]*(?:parte|epis[oó]dio|ep\.?)\s*(\d{1,5})\s*(?:[—–:-]\s*(.*?))?[=\-\s]*$/gim;

function isHashtagLine(line: string): boolean {
  const words = line.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => w.startsWith('#'));
}

export function parseCaptionFile(text: string): CaptionEntry[] {
  const headers = [...text.matchAll(HEADER)];
  const byNumber = new Map<number, CaptionEntry>();
  headers.forEach((h, i) => {
    const start = h.index + h[0].length;
    const end = headers[i + 1]?.index ?? text.length;
    const lines = text.slice(start, end).trim().split(/\r?\n/);
    const tags: string[] = [];
    while (lines.length > 0 && (isHashtagLine(lines.at(-1)!) || !lines.at(-1)!.trim())) {
      const line = lines.pop()!;
      if (line.trim()) tags.unshift(line);
    }
    const episodeNumber = Number(h[1]);
    byNumber.set(episodeNumber, {
      episodeNumber,
      subtitle: (h[2] ?? '').trim(),
      caption: lines.join('\n').trim(),
      hashtags: normalizeHashtags(tags.join(' ')),
    });
  });
  return [...byNumber.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

/** "O ASSOBIO" vira "O Assobio". Texto já em caixa mista fica como veio. */
function titleCase(text: string): string {
  if (text !== text.toLocaleUpperCase('pt-BR')) return text;
  return text
    .toLocaleLowerCase('pt-BR')
    .replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => space + letter.toLocaleUpperCase('pt-BR'));
}

export function captionEpisodeTitle(seriesTitle: string, episodeNumber: number, subtitle: string): string {
  const base = `${seriesTitle} - Parte ${episodeNumber}`;
  return subtitle ? `${base}: ${titleCase(subtitle)}` : base;
}
