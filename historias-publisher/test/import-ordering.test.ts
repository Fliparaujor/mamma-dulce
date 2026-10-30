import { describe, expect, it } from 'vitest';
import { parseEpisodeFilename, sortImportCandidates } from '../shared/filename';
import { composeCaption, normalizeHashtags, validateCaption } from '../shared/captions';

describe('importação: detecção de série e episódio pelo nome do arquivo', () => {
  it.each([
    ['Historia_01_Ep01.mp4', 'historia-1', 1, 'high'],
    ['Historia_01_Ep12.mp4', 'historia-1', 12, 'high'],
    ['historia-1-ep-3.mov', 'historia-1', 3, 'high'],
    ['A Casa Amarela - Episódio 7.mp4', 'a-casa-amarela', 7, 'high'],
    ['Lenda do Boto parte 2.mp4', 'lenda-do-boto', 2, 'high'],
    ['Saci S01E04.mp4', 'saci-t1', 4, 'high'],
    ['Historia 02 - 05.mp4', 'historia-2', 5, 'low'],
  ] as const)('%s → série %s, episódio %d', (file, seriesKey, ep, confidence) => {
    const parsed = parseEpisodeFilename(file);
    expect(parsed.seriesKey).toBe(seriesKey);
    expect(parsed.episodeNumber).toBe(ep);
    expect(parsed.confidence).toBe(confidence);
  });

  it('marca como sem confiança quando não há número', () => {
    const parsed = parseEpisodeFilename('trailer final.mp4');
    expect(parsed.episodeNumber).toBeNull();
    expect(parsed.confidence).toBe('none');
  });

  it('ordena 60 arquivos embaralhados por série e episódio (Ep2 antes de Ep10)', () => {
    const files: string[] = [];
    for (const h of [1, 2]) for (let e = 1; e <= 30; e++) files.push(`Historia_${String(h).padStart(2, '0')}_Ep${String(e).padStart(2, '0')}.mp4`);
    const shuffled = [...files].sort(() => Math.random() - 0.5);
    // nomes sem zero à esquerda também devem ordenar certo
    shuffled.push('Historia_03_Ep2.mp4', 'Historia_03_Ep10.mp4', 'Historia_03_Ep1.mp4');
    const sorted = sortImportCandidates(shuffled.map((filename) => ({ filename, parsed: parseEpisodeFilename(filename) })));
    expect(sorted.slice(0, 60).map((s) => s.filename)).toEqual(files);
    expect(sorted.slice(60).map((s) => s.parsed.episodeNumber)).toEqual([1, 2, 10]);
  });
});

describe('legendas e hashtags', () => {
  it('normaliza hashtags sem repetir', () => {
    expect(normalizeHashtags('historias, #Lendas lendas  #folclore')).toBe('#historias #Lendas #folclore');
  });

  it('usa a legenda geral em todas as redes no modo compartilhado', () => {
    const text = composeCaption({
      captionMode: 'shared',
      sharedCaption: 'Parte 1 da lenda.',
      sharedHashtags: '#lenda',
      seriesHashtags: '#boto',
      platformCaption: 'ignorada no modo compartilhado',
      platformHashtags: null,
    });
    expect(text).toBe('Parte 1 da lenda.\n\n#lenda #boto');
  });

  it('usa legenda e hashtags próprias da rede no modo personalizado', () => {
    const text = composeCaption({
      captionMode: 'custom',
      sharedCaption: 'Geral',
      sharedHashtags: '#geral',
      seriesHashtags: '',
      platformCaption: 'Só no TikTok',
      platformHashtags: 'fyp',
    });
    expect(text).toBe('Só no TikTok\n\n#fyp');
  });

  it('aponta legenda longa demais e título ausente no YouTube', () => {
    expect(validateCaption('instagram', 'x'.repeat(2197))).toHaveLength(1);
    expect(validateCaption('youtube', 'ok', '')).toEqual([{ platform: 'youtube', message: 'O YouTube exige um título.' }]);
    expect(validateCaption('youtube', 'ok', 'y'.repeat(101))).toHaveLength(1);
  });
});
