import { beforeEach, describe, expect, it } from 'vitest';
import { autoTimes } from '../shared/calendar';
import { captionEpisodeTitle, parseCaptionFile } from '../shared/legendas';
import { addDays, localDate, localTime } from '../shared/time';
import { call, login, resetDb, seedEpisodes } from './helpers';

const TZ = 'America/Belem';

const SAMPLE = `ENCANTADOS — legendas dos posts, partes 1 a 10
Hashtags fixas no fim de cada uma.

==================== PARTE 1 — O ASSOBIO ====================
Se ouvir um assobio, não responde. 🌑

Parte 1 de 40. 🔥
#Encantados #Suspense #Parte1

==================== PARTE 2 — PÉS PRA TRÁS ====================
Segunda legenda.
#Encantados #Parte2
`;

describe('arquivo de legendas', () => {
  it('separa legenda, hashtags e subtítulo sem confundir "Parte 1 de 40"', () => {
    const entries = parseCaptionFile(SAMPLE);
    expect(entries.map((e) => e.episodeNumber)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({
      subtitle: 'O ASSOBIO',
      caption: 'Se ouvir um assobio, não responde. 🌑\n\nParte 1 de 40. 🔥',
      hashtags: '#Encantados #Suspense #Parte1',
    });
  });

  it('monta o título do episódio', () => {
    expect(captionEpisodeTitle('Encantados', 3, 'PÉS PRA TRÁS')).toBe('Encantados - Parte 3: Pés Pra Trás');
    expect(captionEpisodeTitle('Encantados', 3, '')).toBe('Encantados - Parte 3');
  });
});

describe('horários da agenda automática', () => {
  it('2 por dia a partir das 12h com 8 h de intervalo', () => {
    expect(autoTimes('12:00', 2, 8)).toEqual(['12:00', '20:00']);
  });
  it('recusa passar da meia-noite', () => {
    expect(() => autoTimes('12:00', 3, 8)).toThrow(/meia-noite/);
  });
});

describe('agenda automática (API + D1)', () => {
  beforeEach(resetDb);

  const times = (items: { slot: { scheduledAt: string } }[]) =>
    items.map((i) => `${localDate(i.slot.scheduledAt, TZ)} ${localTime(i.slot.scheduledAt, TZ)}`);

  it('calendário vazio começa amanhã às 12h, 2 por dia', async () => {
    await seedEpisodes(3);
    const auth = await login();
    const res = await call('POST', '/api/calendar/auto/preview', { auth, body: {} });
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as { plan: { items: { slot: { scheduledAt: string } }[] } };
    const d1 = addDays(localDate(new Date(), TZ), 1);
    expect(times(plan.items)).toEqual([`${d1} 12:00`, `${d1} 20:00`, `${addDays(d1, 1)} 12:00`]);
  });

  it('continua depois do último post e não agenda de novo quem já tem data', async () => {
    await seedEpisodes(3);
    const auth = await login();
    await call('POST', '/api/calendar/auto/commit', { auth, body: {} });
    const more = await seedEpisodes(2, 'Historia 02');
    const res = await call('POST', '/api/calendar/auto/preview', { auth, body: {} });
    const { plan } = (await res.json()) as { plan: { items: { episodeId: number; slot: { scheduledAt: string } }[] } };
    expect(plan.items.map((i) => i.episodeId)).toEqual(more);
    const d2 = addDays(localDate(new Date(), TZ), 2);
    expect(times(plan.items)).toEqual([`${d2} 20:00`, `${addDays(d2, 1)} 12:00`]);
  });

  it('aplica as legendas pelo número do episódio e avisa o que não achou', async () => {
    await seedEpisodes(1, 'Encantados');
    const auth = await login();
    const res = await call('POST', '/api/episodes/captions', {
      auth,
      body: { seriesName: 'Encantados', items: parseCaptionFile(SAMPLE) },
    });
    expect(await res.json()).toEqual({ updated: 1, missing: [2] });
  });
});
