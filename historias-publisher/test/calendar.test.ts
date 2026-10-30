import { beforeEach, describe, expect, it } from 'vitest';
import { planCalendar, type PlanEpisode } from '../shared/calendar';
import { localDate, localTime } from '../shared/time';
import { call, jobsByState, login, resetDb, seedEpisodes, env } from './helpers';

const TZ = 'America/Belem';
const NOW = new Date('2026-10-31T12:00:00.000Z');

function episodes(n: number, platforms: PlanEpisode['platforms'] = ['instagram', 'tiktok', 'youtube', 'kwai']): PlanEpisode[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, label: `Ep ${i + 1}`, platforms }));
}

describe('gerador de calendário (lógica pura)', () => {
  it('60 episódios viram 30 dias com 2 horários (12h e 19h) e 4 publicações cada', () => {
    const plan = planCalendar(
      { startDate: '2026-11-01', days: 30, times: ['19:00', '12:00'], timeZone: TZ, minLeadMinutes: 20 },
      episodes(60),
      [],
      NOW,
    );
    expect(plan.items).toHaveLength(60);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.items.reduce((a, i) => a + i.platforms.length, 0)).toBe(240);
    // sequência preservada: episódio 1 às 12h do dia 1, episódio 2 às 19h do dia 1, episódio 60 às 19h do dia 30
    expect(plan.items[0]).toMatchObject({ episodeId: 1, slot: { date: '2026-11-01', time: '12:00', scheduledAt: '2026-11-01T15:00:00.000Z' } });
    expect(plan.items[1]).toMatchObject({ episodeId: 2, slot: { date: '2026-11-01', time: '19:00', scheduledAt: '2026-11-01T22:00:00.000Z' } });
    expect(plan.items[59]).toMatchObject({ episodeId: 60, slot: { date: '2026-11-30', time: '19:00' } });
    const perDay = new Map<string, number>();
    for (const it of plan.items) perDay.set(it.slot.date, (perDay.get(it.slot.date) ?? 0) + 1);
    expect([...perDay.values()].every((n) => n === 2)).toBe(true);
    expect(perDay.size).toBe(30);
  });

  it('pula horários no passado e não reutiliza horário ocupado', () => {
    const plan = planCalendar(
      { startDate: '2026-10-31', days: 2, times: ['08:00', '12:00', '19:00'], timeZone: TZ, minLeadMinutes: 20 },
      episodes(3, ['instagram']),
      [{ episodeId: 99, platform: 'tiktok', scheduledAt: '2026-10-31T22:00:00.000Z' }],
      NOW, // 09:00 em Belém
    );
    expect(plan.pastSlots).toBe(1); // 31/10 08:00
    expect(plan.occupiedSlots).toBe(1); // 31/10 19:00 ocupado pelo episódio 99
    expect(plan.items.map((i) => `${i.slot.date} ${i.slot.time}`)).toEqual(['2026-10-31 12:00', '2026-11-01 08:00', '2026-11-01 12:00']);
  });

  it('não duplica episódio já programado e completa redes que faltam no mesmo horário', () => {
    const plan = planCalendar(
      { startDate: '2026-11-01', days: 3, times: ['12:00', '19:00'], timeZone: TZ, minLeadMinutes: 20 },
      episodes(2, ['instagram', 'tiktok']),
      [
        { episodeId: 1, platform: 'instagram', scheduledAt: '2026-11-01T15:00:00.000Z' },
        { episodeId: 1, platform: 'tiktok', scheduledAt: '2026-11-01T15:00:00.000Z' },
        { episodeId: 2, platform: 'instagram', scheduledAt: '2026-11-01T22:00:00.000Z' },
      ],
      NOW,
    );
    expect(plan.skipped.map((s) => s.episodeId)).toEqual([1]);
    expect(plan.items).toEqual([expect.objectContaining({ episodeId: 2, platforms: ['tiktok'], reusedExistingTime: true })]);
  });

  it('avisa quando faltam horários', () => {
    const plan = planCalendar(
      { startDate: '2026-11-01', days: 1, times: ['12:00', '19:00'], timeZone: TZ, minLeadMinutes: 20 },
      episodes(3, ['instagram']),
      [],
      NOW,
    );
    expect(plan.items).toHaveLength(2);
    expect(plan.skipped[0]).toMatchObject({ episodeId: 3, reason: expect.stringContaining('Sem horário livre') });
  });

  it('rejeita configuração inválida', () => {
    expect(() =>
      planCalendar({ startDate: '2026-11-01', days: 0, times: ['12:00'], timeZone: TZ, minLeadMinutes: 0 }, [], [], NOW),
    ).toThrow(/dias/);
    expect(() =>
      planCalendar({ startDate: '2026-11-01', days: 3, times: ['12:00', '12:00'], timeZone: TZ, minLeadMinutes: 0 }, [], [], NOW),
    ).toThrow(/repetidos/);
  });
});

describe('gerador de calendário (API + D1)', () => {
  beforeEach(resetDb);

  it('cria 240 publicações para 60 episódios e não duplica ao confirmar de novo', async () => {
    await seedEpisodes(30, 'Historia 01');
    await seedEpisodes(30, 'Historia 02');
    const auth = await login();
    const tomorrow = localDate(new Date(Date.now() + 24 * 3600_000), TZ);
    const body = { startDate: tomorrow, days: 30, times: ['12:00', '19:00'], platforms: ['instagram', 'tiktok', 'youtube', 'kwai'] };

    const preview = await call('POST', '/api/calendar/preview', { auth, body });
    expect(preview.status).toBe(200);
    const pv = (await preview.json()) as { plan: { items: unknown[] } };
    expect(pv.plan.items).toHaveLength(60);
    expect(await jobsByState()).toEqual({}); // pré-visualização não grava nada

    const first = await call('POST', '/api/calendar/commit', { auth, body });
    expect(((await first.json()) as { created: number }).created).toBe(240);

    const second = await call('POST', '/api/calendar/commit', { auth, body });
    const again = (await second.json()) as { created: number; plan: { skipped: unknown[] } };
    expect(again.created).toBe(0);
    expect(again.plan.skipped).toHaveLength(60);
    expect(await jobsByState()).toEqual({ planned: 240 });

    // ordem da história preservada: Historia 01 Ep 1 é a primeira; Historia 02 Ep 30 a última.
    const rows = await env.DB.prepare(
      `SELECT s.title, e.episode_number, j.scheduled_at FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id
       JOIN series s ON s.id = e.series_id WHERE j.platform = 'instagram' ORDER BY j.scheduled_at`,
    ).all<{ title: string; episode_number: number; scheduled_at: string }>();
    const list = rows.results!;
    expect(list[0]).toMatchObject({ title: 'Historia 01', episode_number: 1 });
    expect(list[30]).toMatchObject({ title: 'Historia 02', episode_number: 1 });
    expect(list[59]).toMatchObject({ title: 'Historia 02', episode_number: 30 });
    expect(localTime(list[0]!.scheduled_at, TZ)).toBe('12:00');
    expect(localTime(list[1]!.scheduled_at, TZ)).toBe('19:00');
  });

  it('o banco recusa duas publicações vivas do mesmo episódio na mesma rede', async () => {
    const [ep] = await seedEpisodes(1);
    const now = new Date().toISOString();
    const insert = (at: string) =>
      env.DB.prepare(
        `INSERT INTO publication_jobs (episode_id, platform, scheduled_at, state, created_at, updated_at) VALUES (?, 'tiktok', ?, 'planned', ?, ?)`,
      )
        .bind(ep, at, now, now)
        .run();
    await insert('2030-01-01T15:00:00.000Z');
    await expect(insert('2030-01-02T15:00:00.000Z')).rejects.toThrow(/UNIQUE/);
  });
});
