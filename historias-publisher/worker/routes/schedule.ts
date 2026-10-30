import { Hono } from 'hono';
import { z } from 'zod';
import { PLATFORMS } from '../../shared/constants';
import { isValidDate, isValidTime, zonedToUtc } from '../../shared/time';
import { kwaiQueue } from '../kwai';
import { all, first } from '../lib/db';
import { badRequest, parseWith, readJson } from '../lib/http';
import { runScheduler } from '../scheduler/run';
import {
  buildPlan,
  cancelJob,
  commitPlan,
  confirmManual,
  jobAttempts,
  rescheduleJob,
  retryJob,
  shiftJobs,
  undoManual,
} from '../services/publications';
import { mediaPath } from '../services/media';
import { getSettings, saveSettings } from '../settings';
import type { AppEnv } from './types';

const schedule = new Hono<AppEnv>();

const idParam = z.coerce.number().int().positive();
const dateStr = z.string().refine(isValidDate, 'data inválida (AAAA-MM-DD)');
const timeStr = z.string().refine(isValidTime, 'horário inválido (HH:MM)');
const platformList = z.array(z.enum(PLATFORMS)).min(1);

const calendarInput = z.object({
  startDate: dateStr,
  days: z.number().int().min(1).max(120),
  times: z.array(timeStr).min(1).max(12),
  platforms: platformList,
  episodeIds: z.array(z.number().int().positive()).max(1000).optional(),
});

schedule.post('/calendar/preview', async (c) => {
  const body = parseWith(calendarInput, await readJson(c.req.raw));
  const { plan, timezone } = await buildPlan(c.env, body);
  return c.json({ plan, timezone });
});

schedule.post('/calendar/commit', async (c) => {
  const body = parseWith(calendarInput, await readJson(c.req.raw));
  const result = await commitPlan(c.env, body);
  return c.json(result);
});

interface JobListRow {
  id: number;
  episode_id: number;
  platform: string;
  scheduled_at: string;
  state: string;
  buffer_post_id: string | null;
  buffer_status: string | null;
  buffer_scheduling_type: string | null;
  published_at: string | null;
  external_url: string | null;
  last_error: string | null;
  attention_reason: string | null;
  attempt_count: number;
  manual_confirmed_at: string | null;
  dry_run_checked_at: string | null;
  updated_at: string;
  episode_title: string;
  episode_number: number;
  series_title: string;
  series_id: number;
  m_id: string | null;
  m_token: string | null;
  m_key: string | null;
  m_status: string | null;
}

const JOB_LIST_SELECT = `
SELECT j.id, j.episode_id, j.platform, j.scheduled_at, j.state, j.buffer_post_id, j.buffer_status, j.buffer_scheduling_type,
       j.published_at, j.external_url, j.last_error, j.attention_reason, j.attempt_count, j.manual_confirmed_at, j.dry_run_checked_at, j.updated_at,
       e.title AS episode_title, e.episode_number, s.title AS series_title, s.id AS series_id,
       m.id AS m_id, m.public_token AS m_token, m.r2_key AS m_key, m.status AS m_status
FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id JOIN series s ON s.id = e.series_id
LEFT JOIN media_assets m ON m.id = e.media_asset_id`;

function shapeJob(r: JobListRow) {
  return {
    id: r.id,
    episodeId: r.episode_id,
    platform: r.platform,
    scheduledAt: r.scheduled_at,
    state: r.state,
    bufferPostId: r.buffer_post_id,
    bufferStatus: r.buffer_status,
    bufferSchedulingType: r.buffer_scheduling_type,
    publishedAt: r.published_at,
    externalUrl: r.external_url,
    lastError: r.last_error,
    attentionReason: r.attention_reason,
    attemptCount: r.attempt_count,
    manualConfirmedAt: r.manual_confirmed_at,
    dryRunCheckedAt: r.dry_run_checked_at,
    updatedAt: r.updated_at,
    episodeTitle: r.episode_title,
    episodeNumber: r.episode_number,
    seriesTitle: r.series_title,
    seriesId: r.series_id,
    mediaPath: r.m_id && r.m_token && r.m_key && r.m_status === 'ready' ? mediaPath({ id: r.m_id, public_token: r.m_token, r2_key: r.m_key }) : null,
  };
}

const listQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  state: z.string().max(200).optional(),
  platform: z.enum(PLATFORMS).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

schedule.get('/jobs', async (c) => {
  const q = parseWith(listQuery, c.req.query());
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.from) {
    where.push('j.scheduled_at >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('j.scheduled_at < ?');
    params.push(q.to);
  }
  if (q.platform) {
    where.push('j.platform = ?');
    params.push(q.platform);
  }
  if (q.state) {
    const states = q.state.split(',').filter(Boolean);
    where.push(`j.state IN (${states.map(() => '?').join(', ')})`);
    params.push(...states);
  } else {
    where.push(`j.state <> 'cancelled'`);
  }
  const rows = await all<JobListRow>(
    c.env.DB,
    `${JOB_LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.scheduled_at ASC, j.platform ASC LIMIT ?`,
    ...params,
    q.limit,
  );
  return c.json({ jobs: rows.map(shapeJob) });
});

schedule.get('/jobs/:id', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const row = await first<JobListRow>(c.env.DB, `${JOB_LIST_SELECT} WHERE j.id = ?`, id);
  if (!row) return c.json({ error: { message: 'Publicação não encontrada.' } }, 404);
  const attempts = await jobAttempts(c.env, id);
  return c.json({ job: shapeJob(row), attempts });
});

const rescheduleInput = z.object({ date: dateStr, time: timeStr });

schedule.post('/jobs/:id/reschedule', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const body = parseWith(rescheduleInput, await readJson(c.req.raw));
  return c.json({ job: await rescheduleJob(c.env, id, body.date, body.time) });
});

schedule.post('/episodes/:id/reschedule', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const body = parseWith(rescheduleInput, await readJson(c.req.raw));
  const jobs = await all<{ id: number }>(
    c.env.DB,
    `SELECT id FROM publication_jobs WHERE episode_id = ? AND state NOT IN ('cancelled', 'published', 'creating')`,
    id,
  );
  if (jobs.length === 0) throw badRequest('Este episódio não tem publicações que possam ser reagendadas.');
  const results: { id: number; ok: boolean; error?: string }[] = [];
  for (const j of jobs) {
    try {
      await rescheduleJob(c.env, j.id, body.date, body.time);
      results.push({ id: j.id, ok: true });
    } catch (e) {
      results.push({ id: j.id, ok: false, error: (e as Error).message });
    }
  }
  return c.json({ results });
});

schedule.post('/jobs/:id/cancel', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  return c.json({ job: await cancelJob(c.env, id) });
});

schedule.post('/jobs/:id/retry', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  return c.json({ job: await retryJob(c.env, id) });
});

const confirmInput = z.object({ note: z.string().trim().max(500).optional() });

schedule.post('/jobs/:id/manual-confirm', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  const body = parseWith(confirmInput, await readJson(c.req.raw));
  return c.json({ job: await confirmManual(c.env, id, body.note || null) });
});

schedule.post('/jobs/:id/manual-undo', async (c) => {
  const id = parseWith(idParam, c.req.param('id'));
  return c.json({ job: await undoManual(c.env, id) });
});

const shiftInput = z.object({
  fromDate: dateStr,
  days: z.number().int().min(-60).max(60).refine((n) => n !== 0, 'informe um número de dias diferente de zero'),
  platforms: platformList.default([...PLATFORMS]),
});

schedule.post('/jobs/shift', async (c) => {
  const body = parseWith(shiftInput, await readJson(c.req.raw));
  return c.json(await shiftJobs(c.env, body.fromDate, body.days, body.platforms));
});

schedule.post('/jobs/retry-failed', async (c) => {
  const failed = await all<{ id: number }>(c.env.DB, `SELECT id FROM publication_jobs WHERE state = 'failed' ORDER BY scheduled_at LIMIT 10`);
  const results: { id: number; ok: boolean; error?: string }[] = [];
  for (const j of failed) {
    try {
      await retryJob(c.env, j.id);
      results.push({ id: j.id, ok: true });
    } catch (e) {
      results.push({ id: j.id, ok: false, error: (e as Error).message });
    }
  }
  return c.json({ results });
});

schedule.get('/kwai/queue', async (c) => {
  const settings = await getSettings(c.env);
  return c.json(await kwaiQueue(c.env, settings.timezone, new Date()));
});

const runInput = z.object({ syncOnly: z.boolean().default(false) });

schedule.post('/scheduler/run', async (c) => {
  const body = parseWith(runInput, await readJson(c.req.raw));
  const result = await runScheduler(c.env, 'manual', { force: true, syncOnly: body.syncOnly });
  return c.json(result);
});

schedule.post('/scheduler/pause', async (c) => c.json({ settings: await saveSettings(c.env, { autofillPaused: true }) }));
schedule.post('/scheduler/resume', async (c) => c.json({ settings: await saveSettings(c.env, { autofillPaused: false }) }));

schedule.get('/scheduler/runs', async (c) => {
  const rows = await all<{ id: number; trigger: string; started_at: string; finished_at: string | null; status: string; summary: string | null; api_calls: number; error: string | null }>(
    c.env.DB,
    'SELECT * FROM scheduler_runs ORDER BY id DESC LIMIT 30',
  );
  return c.json({
    runs: rows.map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null })),
  });
});

/** Converte data/hora local em instante UTC (usado pela interface para filtros). */
schedule.get('/time/convert', async (c) => {
  const settings = await getSettings(c.env);
  const date = parseWith(dateStr, c.req.query('date'));
  const time = parseWith(timeStr, c.req.query('time') ?? '00:00');
  return c.json({ utc: zonedToUtc(date, time, settings.timezone).toISOString(), timezone: settings.timezone });
});

export default schedule;
