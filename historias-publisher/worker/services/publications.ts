import { autoTimes, planCalendar, planPull, type CalendarConfig, type PlanEpisode, type PullJob } from '../../shared/calendar';
import { isBufferPlatform, PLATFORMS, type Platform } from '../../shared/constants';
import { addDays, localDate, zonedToUtc } from '../../shared/time';
import { BufferError } from '../buffer/client';
import { createBufferSession } from '../buffer/factory';
import { all, first, nowIso, placeholders, run } from '../lib/db';
import { badRequest, conflict, HttpError, notFound } from '../lib/http';
import type { EditPostContent } from '../buffer/api';
import { attemptStatement, buildCreatePostInput, JOB_FOR_PUBLISHING_SELECT, type JobForPublishing, type JobRow } from '../scheduler/jobs';
import { mediaUrl } from './media';
import { acquireLock, releaseLock, SCHEDULER_LOCK, SCHEDULER_LOCK_TTL_MS } from '../scheduler/lock';
import { getSettings, type Settings } from '../settings';
import type { Env } from '../env';

export async function getJob(env: Env, id: number): Promise<JobRow> {
  const job = await first<JobRow>(env.DB, 'SELECT * FROM publication_jobs WHERE id = ?', id);
  if (!job) throw notFound('Publicação não encontrada.');
  return job;
}

function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test((e as Error)?.message ?? '');
}

function bufferSessionOrThrow(env: Env, settings: Settings, maxRequests = 3) {
  const session = createBufferSession(env, { maxRequests });
  if (!session || !settings.bufferOrganizationId) {
    throw new HttpError(503, 'Buffer não configurado. Configure a chave e a organização em Redes conectadas.', 'buffer_not_configured');
  }
  return session;
}

function bufferErrorToHttp(e: unknown): never {
  if (e instanceof BufferError) {
    const status = e.kind === 'rate_limited' ? 429 : e.kind === 'unauthorized' ? 502 : 502;
    throw new HttpError(status, e.outcomeUnknown ? `${e.message} Confira no Buffer antes de tentar de novo.` : e.message, `buffer_${e.kind}`);
  }
  throw e;
}

/** Texto, vídeo e metadados de cada publicação, para reenviar no editPost. */
async function editContents(env: Env, settings: Settings, ids: number[]): Promise<Map<number, EditPostContent>> {
  const out = new Map<number, EditPostContent>();
  if (ids.length === 0) return out;
  const rows = await all<JobForPublishing>(env.DB, `${JOB_FOR_PUBLISHING_SELECT} WHERE j.id IN (${placeholders(ids.length)})`, ...ids);
  for (const row of rows) {
    const url = row.m_id && row.m_token && row.m_key ? mediaUrl(env, { id: row.m_id, public_token: row.m_token, r2_key: row.m_key }) : null;
    if (!url) continue;
    const { text, assets, metadata } = buildCreatePostInput(row, '', url, settings);
    out.set(row.id, { text, assets, metadata });
  }
  return out;
}

/** Reagenda uma publicação. Se já estiver no Buffer, altera o dueAt lá antes (editPost). */
export async function rescheduleJob(env: Env, id: number, date: string, time: string, now = new Date()): Promise<JobRow> {
  const settings = await getSettings(env);
  const job = await getJob(env, id);
  let instant: string;
  try {
    instant = zonedToUtc(date, time, settings.timezone).toISOString();
  } catch {
    throw badRequest('Data ou horário inválido.');
  }
  const minStart = now.getTime() + (isBufferPlatform(job.platform) ? settings.minLeadMinutes : 0) * 60_000;
  if (new Date(instant).getTime() < minStart) {
    throw badRequest(
      isBufferPlatform(job.platform)
        ? `Escolha um horário com pelo menos ${settings.minLeadMinutes} minutos de antecedência.`
        : 'Escolha um horário no futuro.',
    );
  }
  if (job.state === 'creating') throw conflict('O envio ao Buffer está em andamento. Aguarde a confirmação.');
  if (job.state === 'published' || job.state === 'cancelled') throw conflict('Publicações concluídas ou canceladas não podem ser reagendadas.');

  const nowS = nowIso(now);
  const liveInBuffer = job.state === 'scheduled_buffer' && job.buffer_post_id;
  if (liveInBuffer) {
    const session = bufferSessionOrThrow(env, settings);
    try {
      const content = (await editContents(env, settings, [id])).get(id);
      const result = await session.api.reschedulePost(job.buffer_post_id!, instant, content);
      if (!result.ok) throw new HttpError(422, `O Buffer recusou o reagendamento: ${result.message}`, 'buffer_rejected');
      try {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE publication_jobs SET scheduled_at = ?, buffer_due_at = ?, buffer_status = ?, updated_at = ? WHERE id = ?`,
          ).bind(instant, result.post.dueAt ?? instant, result.post.status, nowS, id),
          attemptStatement(env.DB, id, 'edit', 'success', `Reagendado no Buffer para ${instant}.`, null, null, now),
        ]);
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Já existe outra publicação desta rede nesse horário.');
        throw e;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      bufferErrorToHttp(e);
    } finally {
      await session.flush();
    }
  } else {
    // Ainda não está no Buffer (ou foi removido de lá): só muda no app e volta para a fila.
    const clearsBuffer = job.buffer_status === 'deleted' || job.state === 'failed';
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE publication_jobs SET scheduled_at = ?, state = 'planned',
             attention_reason = NULL, last_error = NULL, next_attempt_at = NULL, attempt_count = 0,
             buffer_post_id = CASE WHEN ? THEN NULL ELSE buffer_post_id END,
             buffer_status = CASE WHEN ? THEN NULL ELSE buffer_status END,
             updated_at = ? WHERE id = ?`,
        ).bind(instant, clearsBuffer ? 1 : 0, clearsBuffer ? 1 : 0, nowS, id),
        attemptStatement(env.DB, id, 'edit', 'info', `Reagendado no app para ${instant}.`, null, null, now),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe outra publicação desta rede nesse horário.');
      throw e;
    }
  }
  return getJob(env, id);
}

/** Cancela uma publicação. Se estiver agendada no Buffer, remove de lá primeiro (deletePost). */
export async function cancelJob(env: Env, id: number, now = new Date()): Promise<JobRow> {
  const job = await getJob(env, id);
  if (job.state === 'cancelled') return job;
  if (job.state === 'published') throw conflict('Esta publicação já foi publicada; não há o que cancelar.');
  if (job.state === 'creating') throw conflict('O envio ao Buffer está em andamento. Aguarde a confirmação e cancele depois.');
  const nowS = nowIso(now);
  if (job.buffer_post_id && job.buffer_status !== 'deleted' && ['scheduled_buffer', 'manual_pending', 'needs_attention'].includes(job.state)) {
    const settings = await getSettings(env);
    const session = bufferSessionOrThrow(env, settings);
    try {
      const res = await session.api.deletePost(job.buffer_post_id);
      if (!res.ok) throw new HttpError(422, `O Buffer não removeu o post: ${res.message}`, 'buffer_rejected');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (!(e instanceof BufferError && e.kind === 'not_found')) bufferErrorToHttp(e);
    } finally {
      await session.flush();
    }
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE publication_jobs SET state = 'cancelled', updated_at = ? WHERE id = ?`).bind(nowS, id),
    attemptStatement(env.DB, id, 'delete', 'success', job.buffer_post_id ? 'Removido do Buffer e cancelado.' : 'Cancelado no app.', null, null, now),
  ]);
  return getJob(env, id);
}

/** Reprocessamento seguro: só volta para a fila o que comprovadamente não está ativo no Buffer. */
export async function retryJob(env: Env, id: number, now = new Date()): Promise<JobRow> {
  const settings = await getSettings(env);
  const job = await getJob(env, id);
  if (!['failed', 'needs_attention'].includes(job.state)) {
    throw conflict('Só publicações com falha ou que requerem atenção podem ser reprocessadas.');
  }
  if (job.buffer_post_id && job.buffer_status && !['error', 'deleted', 'draft'].includes(job.buffer_status)) {
    throw conflict('Este post ainda existe no Buffer. Cancele-o antes de reenviar para não duplicar.');
  }
  const minStart = now.getTime() + (isBufferPlatform(job.platform) ? settings.minLeadMinutes : 0) * 60_000;
  if (new Date(job.scheduled_at).getTime() < minStart) {
    throw conflict('O horário desta publicação já passou. Reagende para um novo horário (isso também a devolve à fila).');
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE publication_jobs SET state = 'planned', buffer_post_id = NULL, buffer_status = NULL, buffer_due_at = NULL,
         attention_reason = NULL, last_error = NULL, next_attempt_at = NULL, attempt_count = 0, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(now), id),
    attemptStatement(env.DB, id, 'retry', 'info', 'Devolvido à fila pelo administrador.', null, null, now),
  ]);
  return getJob(env, id);
}

export async function confirmManual(env: Env, id: number, note: string | null, now = new Date()): Promise<JobRow> {
  const job = await getJob(env, id);
  if (job.platform !== 'kwai') {
    throw badRequest('A confirmação manual vale só para o Kwai. Para lembretes do Buffer, marque como publicado no app do Buffer.');
  }
  if (!['planned', 'manual_pending', 'needs_attention'].includes(job.state)) {
    throw conflict('Esta publicação não está aguardando confirmação.');
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE publication_jobs SET state = 'published', published_at = ?, manual_confirmed_at = ?, manual_note = ?, attention_reason = NULL, updated_at = ?
       WHERE id = ?`,
    ).bind(nowIso(now), nowIso(now), note, nowIso(now), id),
    attemptStatement(env.DB, id, 'manual_confirm', 'success', note ? `Confirmado pelo administrador: ${note}` : 'Confirmado pelo administrador.', null, null, now),
  ]);
  return getJob(env, id);
}

export async function undoManual(env: Env, id: number, now = new Date()): Promise<JobRow> {
  const job = await getJob(env, id);
  if (job.platform !== 'kwai' || job.state !== 'published' || !job.manual_confirmed_at) {
    throw conflict('Só confirmações manuais do Kwai podem ser desfeitas.');
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE publication_jobs SET state = 'manual_pending', published_at = NULL, manual_confirmed_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(now), id),
    attemptStatement(env.DB, id, 'manual_undo', 'info', 'Confirmação desfeita pelo administrador.', null, null, now),
  ]);
  return getJob(env, id);
}

/** Empurra publicações ainda não enviadas ao Buffer em N dias a partir de uma data. */
export async function shiftJobs(
  env: Env,
  fromDate: string,
  days: number,
  platforms: Platform[],
  now = new Date(),
): Promise<{ moved: number; skippedInBuffer: number }> {
  const settings = await getSettings(env);
  const from = zonedToUtc(fromDate, '00:00', settings.timezone).toISOString();
  const jobs = await all<JobRow>(
    env.DB,
    `SELECT * FROM publication_jobs WHERE scheduled_at >= ? AND platform IN (${placeholders(platforms.length)})
       AND state IN ('planned', 'needs_attention', 'scheduled_buffer', 'manual_pending')
     ORDER BY scheduled_at ${days > 0 ? 'DESC' : 'ASC'}`,
    from,
    ...platforms,
  );
  const movable = jobs.filter((j) => j.state !== 'scheduled_buffer' && !(j.state === 'manual_pending' && j.platform !== 'kwai'));
  const skippedInBuffer = jobs.length - movable.length;
  const delta = days * 24 * 3600_000;
  const minStart = now.getTime() + settings.minLeadMinutes * 60_000;
  const stmts: D1PreparedStatement[] = [];
  for (const j of movable) {
    const next = new Date(new Date(j.scheduled_at).getTime() + delta);
    if (next.getTime() < minStart) throw badRequest('O deslocamento levaria publicações para o passado.');
    stmts.push(
      env.DB.prepare(
        `UPDATE publication_jobs SET scheduled_at = ?, state = 'planned', attention_reason = NULL, updated_at = ? WHERE id = ?`,
      ).bind(next.toISOString(), nowIso(now), j.id),
    );
  }
  if (stmts.length) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('O deslocamento colide com publicações já agendadas no Buffer. Nada foi alterado.');
      throw e;
    }
  }
  return { moved: movable.length, skippedInBuffer };
}

// ---------- Puxar episódio ----------

/** Teto de edições no Buffer por pedido: o plano Free do Workers limita as chamadas externas a 50. */
const MAX_PULL_EDITS = 40;

interface PullRow {
  id: number;
  episode_id: number;
  platform: Platform;
  scheduled_at: string;
  state: string;
  buffer_post_id: string | null;
  label: string;
}

/** Antecipa um episódio e sobe os seguintes uma vaga. Sem `apply`, só devolve o que mudaria. */
export async function pullEpisode(env: Env, episodeId: number, date: string, time: string, apply: boolean, now = new Date()) {
  const settings = await getSettings(env);
  const minStart = new Date(now.getTime() + settings.minLeadMinutes * 60_000).toISOString();
  const target = zonedToUtc(date, time, settings.timezone).toISOString();
  if (target < minStart) throw badRequest(`Escolha um horário com pelo menos ${settings.minLeadMinutes} minutos de antecedência.`);

  const rows = await all<PullRow>(
    env.DB,
    `SELECT j.id, j.episode_id, j.platform, j.scheduled_at, j.state, j.buffer_post_id, s.title || ' · Ep. ' || e.episode_number AS label
     FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id JOIN series s ON s.id = e.series_id
     WHERE j.state NOT IN ('cancelled', 'published')`,
  );
  if (rows.some((r) => r.state === 'creating')) throw conflict('Há um envio ao Buffer em andamento. Tente de novo em instantes.');

  const isMovable = (r: PullRow) =>
    r.scheduled_at >= minStart &&
    (r.state === 'planned' || (r.state === 'scheduled_buffer' && !!r.buffer_post_id) || (r.state === 'manual_pending' && r.platform === 'kwai'));
  const toPullJob = (r: PullRow): PullJob => ({ id: r.id, episodeId: r.episode_id, label: r.label, platform: r.platform, scheduledAt: r.scheduled_at });
  let moves;
  try {
    moves = planPull(rows.filter(isMovable).map(toPullJob), rows.filter((r) => !isMovable(r)).map(toPullJob), episodeId, target);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  if (!apply) return { moves };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const edits = moves.filter((m) => byId.get(m.jobId)!.state === 'scheduled_buffer').length;
  if (edits > MAX_PULL_EDITS) throw badRequest(`São ${edits} posts para alterar no Buffer; o limite por vez é ${MAX_PULL_EDITS}.`);

  const holder = crypto.randomUUID();
  if (!(await acquireLock(env, SCHEDULER_LOCK, holder, SCHEDULER_LOCK_TTL_MS, now))) {
    throw conflict('O agendador está rodando. Tente de novo em instantes.');
  }
  const session = edits > 0 ? bufferSessionOrThrow(env, settings, edits + 3) : null;
  const contents = await editContents(
    env,
    settings,
    moves.filter((m) => byId.get(m.jobId)!.state === 'scheduled_buffer').map((m) => m.jobId),
  );
  const nowS = nowIso(now);
  const stmts: D1PreparedStatement[] = [];
  let moved = 0;
  let failed: string | undefined;
  try {
    for (const m of moves) {
      const row = byId.get(m.jobId)!;
      if (row.state === 'scheduled_buffer') {
        const result = await session!.api.reschedulePost(row.buffer_post_id!, m.to, contents.get(m.jobId));
        if (!result.ok) {
          failed = `O Buffer recusou ${m.label}: ${result.message}`;
          break;
        }
        stmts.push(
          env.DB.prepare(`UPDATE publication_jobs SET scheduled_at = ?, buffer_due_at = ?, buffer_status = ?, updated_at = ? WHERE id = ?`).bind(
            m.to,
            result.post.dueAt ?? m.to,
            result.post.status,
            nowS,
            m.jobId,
          ),
        );
      } else {
        stmts.push(env.DB.prepare(`UPDATE publication_jobs SET scheduled_at = ?, updated_at = ? WHERE id = ?`).bind(m.to, nowS, m.jobId));
      }
      stmts.push(attemptStatement(env.DB, m.jobId, 'edit', 'info', `Reorganizado de ${m.from} para ${m.to}.`, null, null, now));
      moved++;
    }
  } catch (e) {
    if (!(e instanceof BufferError)) throw e;
    failed = e.outcomeUnknown ? `${e.message} Confira no Buffer.` : e.message;
  } finally {
    // Grava o que o Buffer já aceitou, mesmo se parou no meio.
    if (stmts.length) await env.DB.batch(stmts);
    await session?.flush();
    await releaseLock(env, SCHEDULER_LOCK, holder);
  }
  const pickedPlanned = moves.some((m) => m.episodeId === episodeId && byId.get(m.jobId)!.state === 'planned');
  return { moves, moved, failed, needsSync: !failed && pickedPlanned };
}

// ---------- Calendário ----------

interface EpisodeForPlan {
  id: number;
  title: string;
  episode_number: number;
  series_title: string;
  series_position: number;
  series_id: number;
  disabled_platforms: string | null;
}

export interface CalendarRequest {
  startDate: string;
  days: number;
  times: string[];
  platforms: Platform[];
  episodeIds?: number[];
  /** Só aceita horários depois deste instante (fim do calendário atual). */
  notBefore?: string;
}

export async function buildPlan(env: Env, req: CalendarRequest, now = new Date()) {
  const settings = await getSettings(env);
  const episodes = await all<EpisodeForPlan>(
    env.DB,
    `SELECT e.id, e.title, e.episode_number, s.title AS series_title, s.position AS series_position, s.id AS series_id,
            (SELECT GROUP_CONCAT(platform) FROM episode_platforms ep WHERE ep.episode_id = e.id AND ep.enabled = 0) AS disabled_platforms
     FROM episodes e JOIN series s ON s.id = e.series_id
     ORDER BY s.position ASC, s.id ASC, e.episode_number ASC`,
  );
  const wanted = req.episodeIds ? new Set(req.episodeIds) : null;
  const planEpisodes: PlanEpisode[] = episodes
    .filter((e) => !wanted || wanted.has(e.id))
    .map((e) => {
      const disabled = new Set((e.disabled_platforms ?? '').split(',').filter(Boolean));
      return {
        id: e.id,
        label: `${e.series_title} · Ep. ${e.episode_number}`,
        platforms: req.platforms.filter((p) => !disabled.has(p)),
      };
    });
  const existing = await all<{ episode_id: number; platform: Platform; scheduled_at: string }>(
    env.DB,
    `SELECT episode_id, platform, scheduled_at FROM publication_jobs WHERE state <> 'cancelled'`,
  );
  const cfg: CalendarConfig = {
    startDate: req.startDate,
    days: req.days,
    times: req.times,
    timeZone: settings.timezone,
    minLeadMinutes: settings.minLeadMinutes,
  };
  let plan;
  try {
    plan = planCalendar(
      cfg,
      planEpisodes,
      existing.map((j) => ({ episodeId: j.episode_id, platform: j.platform, scheduledAt: j.scheduled_at })),
      req.notBefore && new Date(req.notBefore) > now ? new Date(req.notBefore) : now,
    );
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  return { plan, timezone: settings.timezone };
}

export async function commitPlan(env: Env, req: CalendarRequest, now = new Date()) {
  const { plan, timezone } = await buildPlan(env, req, now);
  const channels = await all<{ id: number; platform: Platform }>(env.DB, 'SELECT id, platform FROM social_channels WHERE enabled = 1');
  const channelByPlatform = new Map(channels.map((c) => [c.platform, c.id]));
  const nowS = nowIso(now);
  const stmts: D1PreparedStatement[] = [];
  for (const item of plan.items) {
    for (const platform of item.platforms) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO publication_jobs (episode_id, platform, channel_id, scheduled_at, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'planned', ?, ?)`,
        ).bind(item.episodeId, platform, channelByPlatform.get(platform) ?? null, item.slot.scheduledAt, nowS, nowS),
      );
    }
  }
  let created = 0;
  for (let i = 0; i < stmts.length; i += 80) {
    const results = await env.DB.batch(stmts.slice(i, i + 80));
    for (const r of results) created += r.meta.changes ?? 0;
  }
  return { created, ignored: stmts.length - created, plan, timezone };
}

/**
 * Agenda automática: pega os episódios com vídeo que ainda não têm publicação e os coloca depois
 * do último post do calendário. Calendário vazio começa amanhã no primeiro horário.
 */
export async function buildAutoRequest(env: Env, platforms: Platform[], now = new Date()) {
  const settings = await getSettings(env);
  let times: string[];
  try {
    times = autoTimes(settings.autoFirstTime, settings.autoPerDay, settings.autoIntervalHours);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const pending = await all<{ id: number; shared_caption: string; title: string }>(
    env.DB,
    `SELECT e.id, e.shared_caption, e.title FROM episodes e
     WHERE e.media_asset_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM publication_jobs j WHERE j.episode_id = e.id AND j.state <> 'cancelled')`,
  );
  const last = await first<{ at: string | null }>(env.DB, `SELECT MAX(scheduled_at) AS at FROM publication_jobs WHERE state <> 'cancelled'`);
  const tomorrow = addDays(localDate(now, settings.timezone), 1);
  const lastDate = last?.at ? localDate(last.at, settings.timezone) : tomorrow;
  const request: CalendarRequest = {
    startDate: lastDate > tomorrow ? lastDate : tomorrow,
    days: Math.min(120, Math.ceil(pending.length / times.length) + 2),
    times,
    platforms,
    episodeIds: pending.map((p) => p.id),
    notBefore: last?.at ?? undefined,
  };
  return { request, withoutCaption: pending.filter((p) => !p.shared_caption.trim()).map((p) => p.title) };
}

export function assertPlatforms(list: string[]): Platform[] {
  for (const p of list) if (!(PLATFORMS as readonly string[]).includes(p)) throw badRequest(`Rede desconhecida: ${p}`);
  return list as Platform[];
}

export async function jobAttempts(env: Env, id: number) {
  return all(
    env.DB,
    `SELECT id, kind, outcome, message, details, created_at, scheduler_run_id FROM publication_attempts WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
    id,
  );
}

export async function touchEpisode(env: Env, episodeId: number): Promise<void> {
  await run(env.DB, 'UPDATE episodes SET updated_at = ? WHERE id = ?', nowIso(), episodeId);
}
