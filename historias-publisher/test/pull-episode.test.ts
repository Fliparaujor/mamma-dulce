import { beforeEach, describe, expect, it } from 'vitest';
import { planPull, type PullJob } from '../shared/calendar';
import { localDate, localTime } from '../shared/time';
import { runScheduler } from '../worker/scheduler/run';
import type { FakeBuffer } from './fake-buffer';
import { call, configureBuffer, env, installFakeBuffer, login, resetDb, scheduleJobs, seedEpisodes, type Auth } from './helpers';

const TZ = 'America/Belem';
const HOUR = 3600_000;

const job = (id: number, episodeId: number, scheduledAt: string, platform = 'instagram'): PullJob =>
  ({ id, episodeId, label: `Ep. ${episodeId}`, platform, scheduledAt }) as PullJob;
const A = '2026-11-01T15:00:00.000Z';
const B = '2026-11-01T23:00:00.000Z';
const C = '2026-11-02T15:00:00.000Z';
const TODAY = '2026-10-31T20:00:00.000Z';

describe('puxar episódio (plano)', () => {
  it('puxando o primeiro, os seguintes sobem uma vaga', () => {
    const moves = planPull([job(1, 1, A), job(2, 2, B), job(3, 3, C)], [], 1, TODAY);
    expect(moves.map((m) => [m.jobId, m.to])).toEqual([
      [1, TODAY],
      [2, A],
      [3, B],
    ]);
  });

  it('puxando um do meio, os anteriores ficam onde estão', () => {
    const moves = planPull([job(1, 1, A), job(2, 2, B), job(3, 3, C)], [], 2, TODAY);
    expect(moves.map((m) => [m.jobId, m.to])).toEqual([
      [2, TODAY],
      [3, B],
    ]);
  });

  it('recusa horário depois do atual e colisão', () => {
    expect(() => planPull([job(1, 1, A)], [], 1, B)).toThrow(/antes/);
    expect(() => planPull([job(1, 1, A)], [{ platform: 'instagram', scheduledAt: TODAY }], 1, TODAY)).toThrow(/ocupado/);
  });
});

describe('puxar episódio (API + Buffer)', () => {
  let fake: FakeBuffer;
  let auth: Auth;

  beforeEach(async () => {
    await resetDb();
    fake = installFakeBuffer();
    await configureBuffer();
    auth = await login();
  });

  const slots = async () =>
    (await env.DB.prepare(`SELECT episode_id, scheduled_at, state, buffer_post_id FROM publication_jobs ORDER BY scheduled_at`).all<{
      episode_id: number;
      scheduled_at: string;
      state: string;
      buffer_post_id: string | null;
    }>()).results!;

  it('prévia não muda nada; confirmar move no app e no Buffer', async () => {
    const ids = await seedEpisodes(3);
    const start = new Date(Date.now() + 10 * HOUR);
    start.setUTCSeconds(0, 0);
    await scheduleJobs(ids, start, ['instagram']);
    await runScheduler(env, 'manual');
    const before = await slots();
    expect(before.every((j) => j.state === 'scheduled_buffer')).toBe(true);

    const target = new Date(Date.now() + 3 * HOUR);
    const body = { date: localDate(target, TZ), time: localTime(target, TZ) };
    const preview = await call('POST', `/api/episodes/${ids[0]}/pull`, { auth, body });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { moves: unknown[] }).moves).toHaveLength(3);
    expect(fake.callsOf('EditPost')).toBe(0);

    const res = await call('POST', `/api/episodes/${ids[0]}/pull`, { auth, body: { ...body, apply: true } });
    expect(await res.json()).toMatchObject({ moved: 3 });
    expect(fake.callsOf('EditPost')).toBe(3);
    const after = await slots();
    expect(after.map((j) => j.episode_id)).toEqual(ids);
    expect(after[1]!.scheduled_at).toBe(before[0]!.scheduled_at);
    expect(after[2]!.scheduled_at).toBe(before[1]!.scheduled_at);
    const post = fake.posts.find((p) => p.id === after[1]!.buffer_post_id)!;
    expect(post.dueAt).toBe(before[0]!.scheduled_at);
  });

  it('episódio ainda fora do Buffer vai para lá na hora', async () => {
    const ids = await seedEpisodes(2);
    await scheduleJobs(ids, new Date(Date.now() + 10 * HOUR), ['youtube']);
    const target = new Date(Date.now() + HOUR);
    await call('POST', `/api/episodes/${ids[0]}/pull`, {
      auth,
      body: { date: localDate(target, TZ), time: localTime(target, TZ), apply: true },
    });
    expect((await slots())[0]).toMatchObject({ episode_id: ids[0], state: 'scheduled_buffer' });
  });

  it('recusa horário em cima da hora', async () => {
    const ids = await seedEpisodes(1);
    await scheduleJobs(ids, new Date(Date.now() + 10 * HOUR), ['instagram']);
    const target = new Date(Date.now() - HOUR);
    const res = await call('POST', `/api/episodes/${ids[0]}/pull`, { auth, body: { date: localDate(target, TZ), time: localTime(target, TZ) } });
    expect(res.status).toBe(400);
  });
});
