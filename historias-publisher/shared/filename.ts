// Detecta série e número do episódio a partir do nome do arquivo.
// Exemplos aceitos: Historia_01_Ep01.mp4, historia-1-ep-2.mov, "A Casa Amarela - Episódio 3.mp4",
// S01E04.mp4, "Lenda do Boto parte 2.mp4", "Historia 01 - 05.mp4".

export interface ParsedFilename {
  /** Nome legível da série, quando detectado. */
  seriesName: string | null;
  /** Chave estável para agrupar arquivos da mesma série. */
  seriesKey: string | null;
  episodeNumber: number | null;
  /** Rótulo sugerido para o título do episódio. */
  suggestedTitle: string;
  /** Alta: padrão explícito de episódio. Baixa: deduzido do último número do nome. */
  confidence: 'high' | 'low' | 'none';
}

const EXT_RE = /\.(mp4|mov|m4v|webm)$/i;

export function stripExtension(name: string): string {
  return name.replace(EXT_RE, '');
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function prettify(text: string): string {
  const cleaned = text.replace(/[_.]+/g, ' ').replace(/\s*-\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Remove zeros à esquerda de números isolados ("Historia 01" -> "Historia 1") para agrupar variações. */
function normalizeSeriesKey(name: string): string {
  return slugify(name.replace(/\b0+(\d)/g, '$1'));
}

const EPISODE_PATTERNS: RegExp[] = [
  // S01E02
  /^(?<series>.*?)[\s_.-]*s(?<season>\d{1,3})[\s_.-]*e(?<ep>\d{1,4})\b/i,
  // Ep01, Ep 1, Ep-01, EP.01, Episodio 3, Episódio 3, Capitulo 2, Capítulo 2, Parte 2, Part 2
  /^(?<series>.*?)[\s_.-]*(?:ep(?:is[oó]dio|isode)?|cap(?:[ií]tulo)?|parte?|part)[\s_.#-]*(?<ep>\d{1,4})\b/i,
];

export function parseEpisodeFilename(filename: string): ParsedFilename {
  const base = stripExtension(filename.split(/[\\/]/).pop() ?? filename).trim();

  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(base);
    const ep = m?.groups?.ep;
    if (m && ep) {
      const rawSeries = (m.groups?.series ?? '').trim();
      const season = m.groups?.season;
      const seriesBase = season ? `${rawSeries} T${Number(season)}`.trim() : rawSeries;
      const seriesName = prettify(seriesBase) || null;
      const episodeNumber = Number(ep);
      return {
        seriesName,
        seriesKey: seriesName ? normalizeSeriesKey(seriesName) : null,
        episodeNumber: episodeNumber > 0 ? episodeNumber : null,
        suggestedTitle: seriesName ? `${seriesName} · Episódio ${episodeNumber}` : `Episódio ${episodeNumber}`,
        confidence: episodeNumber > 0 ? 'high' : 'none',
      };
    }
  }

  // Sem palavra-chave: usa o último número do nome como episódio ("Historia 01 - 05").
  const tail = /^(?<series>.*?\D)?(?<ep>\d{1,4})\D*$/.exec(base);
  if (tail?.groups?.ep) {
    const episodeNumber = Number(tail.groups.ep);
    const seriesName = prettify((tail.groups.series ?? '').replace(/[\s_.-]+$/, '')) || null;
    if (episodeNumber > 0) {
      return {
        seriesName,
        seriesKey: seriesName ? normalizeSeriesKey(seriesName) : null,
        episodeNumber,
        suggestedTitle: seriesName ? `${seriesName} · Episódio ${episodeNumber}` : `Episódio ${episodeNumber}`,
        confidence: 'low',
      };
    }
  }

  return {
    seriesName: prettify(base) || null,
    seriesKey: base ? normalizeSeriesKey(base) : null,
    episodeNumber: null,
    suggestedTitle: prettify(base) || base,
    confidence: 'none',
  };
}

/** Comparação "natural" (Ep2 antes de Ep10) usada como desempate. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
}

export interface ImportCandidate {
  filename: string;
  parsed: ParsedFilename;
}

/**
 * Ordena arquivos para importação: agrupa por série (na ordem em que a série aparece
 * pela ordenação natural) e dentro da série pelo número do episódio.
 */
export function sortImportCandidates<T extends ImportCandidate>(items: T[]): T[] {
  const firstSeen = new Map<string, string>();
  const byName = [...items].sort((a, b) => naturalCompare(a.filename, b.filename));
  for (const it of byName) {
    const key = it.parsed.seriesKey ?? '';
    if (!firstSeen.has(key)) firstSeen.set(key, it.filename);
  }
  return byName.sort((a, b) => {
    const ka = a.parsed.seriesKey ?? '';
    const kb = b.parsed.seriesKey ?? '';
    if (ka !== kb) return naturalCompare(firstSeen.get(ka) ?? ka, firstSeen.get(kb) ?? kb);
    const ea = a.parsed.episodeNumber ?? Number.MAX_SAFE_INTEGER;
    const eb = b.parsed.episodeNumber ?? Number.MAX_SAFE_INTEGER;
    if (ea !== eb) return ea - eb;
    return naturalCompare(a.filename, b.filename);
  });
}
