import { beforeEach, describe, expect, it } from 'vitest';
import { localDate } from '../shared/time';
import { runScheduler } from '../worker/scheduler/run';
import type { FakeBuffer } from './fake-buffer';
import { call, configureBuffer, env, installFakeBuffer, login, resetDb, scheduleJobs, seedEpisodes, type Auth } from './helpers';

const TZ = 'America/Belem';
const HOUR = 3600_000;
let fake: FakeBuffer;
let auth: Auth;

beforeEach(async () => {
  await resetDb();
  fake = installFakeBuffer();
  await configureBuffer();
  auth = await login();
});

async function job(platform: string) {
  return env.DB.prepare('SELECT * FROM publication_jobs WHERE platform = ?').bind(platform).first<Record<string, string | number | null>>();
}

describe('reagendamento e cancelamento', () => {
  it('reagenda no app quando ainda não foi enviado ao Buffer', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * HOUR), ['instagram']);
    const j = await job('instagram');
    const day = localDate(new Date(Date.now() + 3 * 24 * HOUR), TZ);
    const res = await call('POST', `/api/jobs/${j!.id}/reschedule`, { auth, body: { date: day, time: '19:00' } });
    expect(res.status).toBe(200);
    expect((await job('instagram'))!.scheduled_at).toBe(`${day}T22:00:00.000Z`);
    expect(fake.calls).toHaveLength(0);
  });

  it('reagenda no Buffer (editPost) quando já está agendado lá', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * HOUR), ['instagram']);
    await runScheduler(env, 'manual');
    const j = await job('instagram');
    const day = localDate(new Date(Date.now() + 4 * 24 * HOUR), TZ);
    const res = await call('POST', `/api/jobs/${j!.id}/reschedule`, { auth, body: { date: day, time: '12:00' } });
    expect(res.status).toBe(200);
    expect(fake.callsOf('EditPost')).toBe(1);
    const post = fake.posts.find((p) => p.id === j!.buffer_post_id)!;
    expect(post.dueAt).toBe(`${day}T15:00:00.000Z`);
    expect((await job('instagram'))!.scheduled_at).toBe(`${day}T15:00:00.000Z`);
  });

  it('não aceita horário no passado nem colisão com outro episódio', async () => {
    const [a, b] = await seedEpisodes(2);
    const start = new Date(Date.now() + 5 * HOUR);
    start.setUTCSeconds(0, 0);
    await scheduleJobs([a!, b!], start, ['tiktok']);
    const rows = await env.DB.prepare(`SELECT id, scheduled_at FROM publication_jobs ORDER BY scheduled_at`).all<{ id: number; scheduled_at: string }>();
    const [first, second] = rows.results!;
    const past = await call('POST', `/api/jobs/${first!.id}/reschedule`, { auth, body: { date: '2020-01-01', time: '12:00' } });
    expect(past.status).toBe(400);
    const target = new Date(second!.scheduled_at);
    const collide = await call('POST', `/api/jobs/${first!.id}/reschedule`, {
      auth,
      body: { date: localDate(target, TZ), time: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(target) },
    });
    expect(collide.status).toBe(409);
  });

  it('cancelar remove do Buffer (deletePost) e libera a vaga', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * HOUR), ['youtube']);
    await runScheduler(env, 'manual');
    expect(fake.activeCount('ch_yt')).toBe(1);
    const j = await job('youtube');
    const res = await call('POST', `/api/jobs/${j!.id}/cancel`, { auth, body: {} });
    expect(res.status).toBe(200);
    expect(fake.activeCount('ch_yt')).toBe(0);
    expect((await job('youtube'))!.state).toBe('cancelled');
  });

  it('não cancela o que já foi publicado', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], start, ['youtube']);
    await runScheduler(env, 'manual');
    const later = new Date(start.getTime() + HOUR);
    fake.publishDue(later);
    await runScheduler(env, 'manual', {}, { now: () => later });
    const j = await job('youtube');
    expect(j!.state).toBe('published');
    const res = await call('POST', `/api/jobs/${j!.id}/cancel`, { auth, body: {} });
    expect(res.status).toBe(409);
  });

  it('reprocessar falha devolve à fila e cria uma única vez', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * HOUR), ['tiktok']);
    await env.DB.prepare(`UPDATE publication_jobs SET state = 'failed', last_error = 'teste'`).run();
    const j = await job('tiktok');
    expect((await call('POST', `/api/jobs/${j!.id}/retry`, { auth, body: {} })).status).toBe(200);
    await runScheduler(env, 'manual');
    await runScheduler(env, 'manual');
    expect(fake.posts.filter((p) => p.channelId === 'ch_tt')).toHaveLength(1);
  });

  it('não reprocessa se o post ainda existe no Buffer (evita duplicar)', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * HOUR), ['tiktok']);
    await runScheduler(env, 'manual');
    await env.DB.prepare(`UPDATE publication_jobs SET state = 'needs_attention'`).run();
    const j = await job('tiktok');
    expect((await call('POST', `/api/jobs/${j!.id}/retry`, { auth, body: {} })).status).toBe(409);
  });
});

describe('Kwai: fluxo manual', () => {
  it('aparece na fila manual, só é publicado com confirmação e pode ser desfeito', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 10 * 60_000), ['kwai']);
    await runScheduler(env, 'manual');
    let k = await job('kwai');
    expect(k!.state).toBe('manual_pending'); // nunca vira publicado sozinho
    expect(fake.callsOf('CreatePost')).toBe(0);

    const queue = (await (await call('GET', '/api/kwai/queue', { auth })).json()) as {
      pending: { jobId: number; caption: string; mediaPath: string }[];
    };
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]!.caption).toContain('#historias');
    expect(queue.pending[0]!.mediaPath).toMatch(/^\/media\//);

    const confirm = await call('POST', `/api/jobs/${k!.id}/manual-confirm`, { auth, body: { note: 'postado pelo celular' } });
    expect(confirm.status).toBe(200);
    k = await job('kwai');
    expect(k!.state).toBe('published');
    expect(k!.manual_confirmed_at).toBeTruthy();

    const history = await env.DB.prepare(`SELECT kind, message FROM publication_attempts WHERE job_id = ? ORDER BY id`).bind(k!.id).all<{ kind: string; message: string }>();
    expect(history.results!.map((h) => h.kind)).toContain('manual_confirm');

    expect((await call('POST', `/api/jobs/${k!.id}/manual-undo`, { auth, body: {} })).status).toBe(200);
    expect((await job('kwai'))!.state).toBe('manual_pending');
  });

  it('confirmação manual não vale para redes do Buffer', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * HOUR), ['instagram']);
    const j = await job('instagram');
    expect((await call('POST', `/api/jobs/${j!.id}/manual-confirm`, { auth, body: {} })).status).toBe(400);
  });

  it('gera calendário .ics com alarme para o celular', async () => {
    const [ep] = await seedEpisodes(1);
    await scheduleJobs([ep!], new Date(Date.now() + 5 * HOUR), ['kwai']);
    const settings = (await (await call('GET', '/api/settings', { auth })).json()) as { kwaiCalendarUrl: string };
    const path = new URL(settings.kwaiCalendarUrl).pathname;
    const res = await call('GET', path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const ics = await res.text();
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT30M');
  });
});
