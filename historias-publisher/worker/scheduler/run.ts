// Agendador: reconcilia o estado real do Buffer com o D1 e abastece as vagas livres da fila.
//
// Garantias:
// - Uma execução por vez (trava no D1 com expiração).
// - Antes de criar, lê a ocupação real de cada canal no Buffer (inclui posts criados fora do app).
// - Nunca cria se a ocupação lida for >= limite do canal; LimitReachedError zera as vagas do canal.
// - createPost não tem idempotência no Buffer: a publicação passa para "creating" (troca atômica)
//   antes da chamada. Se a resposta se perder, a próxima execução procura o post pelo canal e dueAt
//   e só volta a "planned" depois de uma janela de segurança sem encontrá-lo.
// - Publicação atrasada nunca é enviada fora do horário: vira "Requer atenção" (ou é cancelada, se
//   essa for a política escolhida).
// - O app conta as próprias requisições e respeita orçamento por execução, teto diário e o
//   Retry-After do Buffer.
import { BUFFER_PLATFORMS, type BufferPlatform, type Platform } from '../../shared/constants';
import type { BufferPost } from '../buffer/api';
import { BufferError } from '../buffer/client';
import { createBufferSession, type BufferSession } from '../buffer/factory';
import { all, bool, first, nowIso, placeholders, run, utcDay } from '../lib/db';
import { log } from '../lib/log';
import { mediaUrl } from '../services/media';
import { getSettings, statement, type Settings } from '../settings';
import type { Env } from '../env';
import {
  attemptStatement,
  backoffMinutes,
  buildCreatePostInput,
  JOB_FOR_PUBLISHING_SELECT,
  publishingProblems,
  publishingWarnings,
  type JobForPublishing,
  type JobRow,
} from './jobs';
import { acquireLock, releaseLockStatement } from './lock';
import { runMediaCleanup } from './cleanup';

const LOCK_NAME = 'scheduler';
const LOCK_TTL_MS = 10 * 60_000;
/** Tempo sem encontrar no Buffer um post em "creating" antes de considerá-lo não criado. */
export const CREATE_RECOVERY_GRACE_MS = 10 * 60_000;
const FULL_SYNC_EVERY_MS = 6 * 3600_000;

export interface SchedulerDeps {
  now?: () => Date;
  /** Sessão do Buffer injetada (testes). undefined = cria a partir do ambiente; null = sem Buffer. */
  buffer?: BufferSession | null;
}

export interface RunOptions {
  /** Ignora o intervalo mínimo entre execuções. */
  force?: boolean;
  /** Só reconcilia, sem criar posts. */
  syncOnly?: boolean;
}

export interface ChannelOccupancy {
  platform: Platform;
  channelId: number;
  name: string;
  used: number | null;
  limit: number;
  free: number | null;
  available: boolean;
  reason: string | null;
}

export interface RunSummary {
  late: number;
  kwaiPending: number;
  bufferPhase: 'executed' | 'not_due' | 'not_configured' | 'backoff' | 'budget' | 'nothing_to_do' | 'locked';
  reconciled: number;
  recovered: number;
  created: number;
  dryRun: number;
  failed: number;
  limitHits: number;
  occupancy: ChannelOccupancy[];
  notes: string[];
  apiCalls: number;
  cleanup: { deleted: number; bytes: number } | null;
}

export interface RunResult {
  runId: number | null;
  status: 'ok' | 'partial' | 'error' | 'skipped';
  summary: RunSummary;
}

interface ChannelRow {
  id: number;
  platform: Platform;
  provider: 'buffer' | 'manual';
  external_id: string | null;
  name: string;
  is_disconnected: number;
  is_locked: number;
  is_queue_paused: number;
  enabled: number;
  queue_limit: number;
}

function emptySummary(): RunSummary {
  return {
    late: 0,
    kwaiPending: 0,
    bufferPhase: 'nothing_to_do',
    reconciled: 0,
    recovered: 0,
    created: 0,
    dryRun: 0,
    failed: 0,
    limitHits: 0,
    occupancy: [],
    notes: [],
    apiCalls: 0,
    cleanup: null,
  };
}

async function readStates(env: Env, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await all<{ key: string; value: string }>(
    env.DB,
    `SELECT key, value FROM app_settings WHERE key IN (${placeholders(keys.length)})`,
    ...keys.map((k) => `state:${k}`),
  );
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key.slice('state:'.length)] = JSON.parse(r.value);
    } catch {
      // ignora valor corrompido
    }
  }
  return out;
}

const BUFFER_IN = `(${BUFFER_PLATFORMS.map((p) => `'${p}'`).join(', ')})`;

/** Etapa local, sem rede: atrasos e fila manual do Kwai. Executa em todo disparo do cron. */
async function localTransitions(env: Env, settings: Settings, now: Date, runId: number | null, summary: RunSummary): Promise<void> {
  const lateCutoff = new Date(now.getTime() + settings.minLeadMinutes * 60_000).toISOString();
  const kwaiCutoff = new Date(now.getTime() + settings.kwaiReminderMinutes * 60_000).toISOString();
  const nowS = now.toISOString();
  const lateState = settings.latePolicy === 'skip' ? 'cancelled' : 'needs_attention';
  const lateReason =
    settings.latePolicy === 'skip'
      ? 'Cancelado automaticamente: o horário passou sem envio ao Buffer (política "pular atrasados").'
      : 'O horário chegou sem o post estar agendado no Buffer. Reagende ou descarte; nada é publicado fora do horário.';
  const lateWhere = `state = 'planned' AND platform IN ${BUFFER_IN} AND scheduled_at < ?`;

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO publication_attempts (job_id, scheduler_run_id, kind, outcome, message, created_at)
       SELECT id, ?, 'state_change', 'info', ?, ? FROM publication_jobs WHERE ${lateWhere}`,
    ).bind(runId, lateReason, nowS, lateCutoff),
    env.DB.prepare(
      `UPDATE publication_jobs SET state = ?, attention_reason = ?, updated_at = ? WHERE ${lateWhere}`,
    ).bind(lateState, lateReason, nowS, lateCutoff),
    env.DB.prepare(
      `UPDATE publication_jobs SET state = 'manual_pending', attention_reason = 'Publicação manual no Kwai.', updated_at = ?
       WHERE state = 'planned' AND platform = 'kwai' AND scheduled_at <= ?`,
    ).bind(nowS, kwaiCutoff),
  ]);
  summary.late = results[1]?.meta.changes ?? 0;
  summary.kwaiPending = results[2]?.meta.changes ?? 0;
}

/** Converte o estado de um post do Buffer para o estado da publicação no app. */
export function mapBufferPost(
  post: BufferPost,
  now: Date,
): { state: JobRow['state']; reason: string | null; error: string | null } {
  if (post.notificationStatus === 'markedAsPublished') return { state: 'published', reason: null, error: null };
  switch (post.status) {
    case 'sent':
      return { state: 'published', reason: null, error: null };
    case 'error':
      return { state: 'failed', reason: null, error: post.error?.message ?? 'O Buffer informou erro na publicação.' };
    case 'needs_approval':
      return { state: 'needs_attention', reason: 'O post aguarda aprovação no Buffer.', error: null };
    case 'draft':
      return { state: 'needs_attention', reason: 'O post foi movido para rascunhos no Buffer e não será publicado.', error: null };
    case 'scheduled':
    case 'sending':
    default: {
      const due = post.dueAt ? new Date(post.dueAt).getTime() : null;
      if (post.schedulingType === 'notification' && due !== null && due <= now.getTime()) {
        return {
          state: 'manual_pending',
          reason: 'O Buffer enviou um lembrete: publique pelo app da rede e marque como publicado no Buffer.',
          error: null,
        };
      }
      return { state: 'scheduled_buffer', reason: null, error: null };
    }
  }
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

export async function runScheduler(
  env: Env,
  trigger: 'cron' | 'manual',
  opts: RunOptions = {},
  deps: SchedulerDeps = {},
): Promise<RunResult> {
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const settings = await getSettings(env);
  const summary = emptySummary();

  const states = await readStates(env, ['scheduler_last_buffer_run', 'buffer_backoff_until', 'public_origin', 'last_cleanup_day']);
  const lastBufferRun = typeof states.scheduler_last_buffer_run === 'string' ? states.scheduler_last_buffer_run : null;
  const due =
    opts.force ||
    trigger === 'manual' ||
    !lastBufferRun ||
    now.getTime() - new Date(lastBufferRun).getTime() >= (settings.schedulerIntervalMinutes - 2) * 60_000;

  const holder = crypto.randomUUID();
  if (!(await acquireLock(env, LOCK_NAME, holder, LOCK_TTL_MS, now))) {
    summary.bufferPhase = 'locked';
    summary.notes.push('Outra execução do agendador está em andamento.');
    return { runId: null, status: 'skipped', summary };
  }

  let runId: number | null = null;
  let session: BufferSession | null = null;
  let status: RunResult['status'] = 'ok';
  let fatal: string | null = null;

  try {
    if (!due) {
      await localTransitions(env, settings, now, null, summary);
      summary.bufferPhase = 'not_due';
      return { runId: null, status: 'skipped', summary };
    }

    const inserted = await first<{ id: number }>(
      env.DB,
      `INSERT INTO scheduler_runs (trigger, started_at, status) VALUES (?, ?, 'running') RETURNING id`,
      trigger,
      nowIso(now),
    );
    runId = inserted?.id ?? null;
    await localTransitions(env, settings, now, runId, summary);

    const backoffUntil = typeof states.buffer_backoff_until === 'string' ? states.buffer_backoff_until : null;
    session = deps.buffer === undefined ? createBufferSession(env, { maxRequests: settings.maxBufferRequestsPerRun }) : deps.buffer;

    if (!session) {
      summary.bufferPhase = 'not_configured';
      summary.notes.push('BUFFER_API_KEY não configurada: nada foi enviado ao Buffer.');
    } else if (!settings.bufferOrganizationId) {
      summary.bufferPhase = 'not_configured';
      summary.notes.push('Escolha a organização do Buffer em Redes conectadas.');
    } else if (backoffUntil && backoffUntil > now.toISOString()) {
      summary.bufferPhase = 'backoff';
      summary.notes.push(`Aguardando liberação do limite do Buffer até ${backoffUntil}.`);
    } else {
      const usedToday = await first<{ value: number }>(
        env.DB,
        `SELECT value FROM usage_daily WHERE day = ? AND metric = 'buffer_requests'`,
        utcDay(now),
      );
      if ((usedToday?.value ?? 0) >= settings.dailyBufferBudget) {
        summary.bufferPhase = 'budget';
        summary.notes.push(`Teto diário de ${settings.dailyBufferBudget} requisições ao Buffer atingido; retomo amanhã (UTC).`);
      } else {
        await bufferPhase(env, settings, session, now, runId, trigger, opts, summary, typeof states.public_origin === 'string' ? states.public_origin : null);
      }
    }

    if (settings.mediaAutoCleanup && states.last_cleanup_day !== utcDay(now)) {
      summary.cleanup = await runMediaCleanup(env, settings, now, { dryRun: false, limit: 10 });
      await statement(env, 'last_cleanup_day', utcDay(now)).run();
    }
    if (summary.failed > 0 || summary.notes.some((n) => n.startsWith('Erro'))) status = 'partial';
  } catch (e) {
    status = 'error';
    fatal = e instanceof Error ? e.message : String(e);
    log('error', 'scheduler.failed', { error: fatal });
  } finally {
    summary.apiCalls = session?.requests ?? 0;
    const finals: D1PreparedStatement[] = [releaseLockStatement(env, LOCK_NAME, holder)];
    if (runId !== null) {
      finals.push(
        env.DB.prepare(`UPDATE scheduler_runs SET finished_at = ?, status = ?, summary = ?, api_calls = ?, error = ? WHERE id = ?`).bind(
          nowIso(clock()),
          status,
          JSON.stringify(summary),
          summary.apiCalls,
          fatal,
          runId,
        ),
      );
    }
    if (summary.bufferPhase === 'executed') finals.push(statement(env, 'scheduler_last_buffer_run', now.toISOString()));
    try {
      await env.DB.batch(finals);
      await session?.flush();
    } catch (e) {
      log('error', 'scheduler.finalize_failed', { error: (e as Error).message });
    }
  }
  return { runId, status, summary };
}

async function bufferPhase(
  env: Env,
  settings: Settings,
  session: BufferSession,
  now: Date,
  runId: number | null,
  trigger: 'cron' | 'manual',
  opts: RunOptions,
  summary: RunSummary,
  publicOrigin: string | null,
): Promise<void> {
  const orgId = settings.bufferOrganizationId!;
  const nowS = now.toISOString();
  const channels = await all<ChannelRow>(
    env.DB,
    `SELECT id, platform, provider, external_id, name, is_disconnected, is_locked, is_queue_paused, enabled, queue_limit
     FROM social_channels WHERE provider = 'buffer' AND enabled = 1 AND external_id IS NOT NULL`,
  );
  if (channels.length === 0) {
    summary.notes.push('Nenhum canal do Buffer mapeado. Sincronize os canais em Redes conectadas.');
    return;
  }
  const byPlatform = new Map<Platform, ChannelRow>(channels.map((c) => [c.platform, c]));
  const byExternal = new Map<string, ChannelRow>(channels.map((c) => [c.external_id!, c]));

  const tracked = await all<JobRow>(
    env.DB,
    `SELECT * FROM publication_jobs
     WHERE platform IN ${BUFFER_IN} AND (state IN ('creating', 'scheduled_buffer')
       OR (state IN ('manual_pending', 'needs_attention', 'failed') AND buffer_post_id IS NOT NULL AND published_at IS NULL
           AND scheduled_at > ?))`,
    new Date(now.getTime() - 3 * 24 * 3600_000).toISOString(),
  );
  const planned = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM publication_jobs WHERE state = 'planned' AND platform IN ${BUFFER_IN}
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    nowS,
  );

  // Sincronização inteligente: só gasta cota quando algo pode ter mudado.
  const lastSync = await first<{ last: string | null }>(
    env.DB,
    `SELECT MAX(last_synced_at) AS last FROM social_channels WHERE provider = 'buffer' AND enabled = 1`,
  );
  const lastSyncMs = lastSync?.last ? new Date(lastSync.last).getTime() : 0;
  const reasons: string[] = [];
  if (trigger === 'manual') reasons.push('manual');
  if (tracked.some((j) => j.state === 'creating')) reasons.push('envio pendente de confirmação');
  if (tracked.some((j) => j.scheduled_at <= nowS)) reasons.push('horário passou, aguardando confirmação');
  if (!opts.syncOnly && !settings.autofillPaused && (planned?.n ?? 0) > 0) {
    const localUsed = new Map<number, number>();
    for (const j of tracked) if (j.channel_id) localUsed.set(j.channel_id, (localUsed.get(j.channel_id) ?? 0) + 1);
    if (channels.some((c) => (localUsed.get(c.id) ?? 0) < c.queue_limit)) reasons.push('há vagas a preencher');
  }
  if (tracked.length > 0 && now.getTime() - lastSyncMs > FULL_SYNC_EVERY_MS) reasons.push('sincronização periódica');
  if (settings.smartSync && reasons.length === 0) {
    summary.bufferPhase = 'nothing_to_do';
    summary.notes.push('Nada mudou desde a última consulta; o Buffer não foi consultado.');
    return;
  }
  summary.bufferPhase = 'executed';

  const channelIds = channels.map((c) => c.external_id!);
  const stmts: D1PreparedStatement[] = [];
  let occupancyComplete = true;

  // 1) Posts que ocupam vaga na fila (inclui os criados fora do app).
  let active: BufferPost[] = [];
  try {
    const res = await session.api.posts(orgId, { channelIds, status: ['scheduled', 'sending', 'needs_approval'] }, 4);
    active = res.posts;
    occupancyComplete = res.complete;
  } catch (e) {
    handleBufferError(e, summary, now, stmts, env);
    await flushStatements(env, stmts);
    return;
  }

  const byId = new Map<string, BufferPost>(active.map((p) => [p.id, p]));
  const occupancyByChannel = new Map<string, number>();
  for (const p of active) occupancyByChannel.set(p.channelId, (occupancyByChannel.get(p.channelId) ?? 0) + 1);

  // 2) Posts concluídos (enviados ou com erro) relacionados a publicações acompanhadas.
  const missing = tracked.filter((j) => !(j.buffer_post_id && byId.has(j.buffer_post_id)));
  if (missing.length > 0) {
    const times = missing.map((j) => new Date(j.scheduled_at).getTime());
    try {
      const done = await session.api.posts(
        orgId,
        {
          channelIds,
          status: ['sent', 'error', 'draft'],
          dueAt: {
            start: new Date(Math.min(...times) - 3600_000).toISOString(),
            end: new Date(Math.max(...times) + 3600_000).toISOString(),
          },
        },
        3,
      );
      for (const p of done.posts) byId.set(p.id, p);
    } catch (e) {
      if (!handleBufferError(e, summary, now, stmts, env)) {
        await flushStatements(env, stmts);
        return;
      }
    }
  }

  // 3) Reconciliação publicação a publicação.
  const individualLookups: JobRow[] = [];
  for (const job of tracked) {
    const channel = job.channel_id ? channels.find((c) => c.id === job.channel_id) : byPlatform.get(job.platform);
    if (job.state === 'creating') {
      const found = [...byId.values()].find(
        (p) => p.channelId === channel?.external_id && sameInstant(p.dueAt, job.scheduled_at) && p.via === 'api',
      );
      if (found) {
        applyPost(env, job, found, now, runId, stmts, summary, 'recover', 'Envio interrompido confirmado: o post existe no Buffer.');
        summary.recovered++;
      } else if (job.create_started_at && now.getTime() - new Date(job.create_started_at).getTime() > CREATE_RECOVERY_GRACE_MS) {
        stmts.push(
          env.DB.prepare(
            `UPDATE publication_jobs SET state = 'planned', create_started_at = NULL, updated_at = ? WHERE id = ? AND state = 'creating'`,
          ).bind(nowS, job.id),
          attemptStatement(env.DB, job.id, 'recover', 'info', 'O envio anterior não chegou ao Buffer; a publicação voltou para a fila do app.', null, runId, now),
        );
        summary.recovered++;
      }
      continue;
    }
    const post = job.buffer_post_id ? byId.get(job.buffer_post_id) : undefined;
    if (post) applyPost(env, job, post, now, runId, stmts, summary, 'reconcile', null);
    else if (job.buffer_post_id && job.state === 'scheduled_buffer') individualLookups.push(job);
  }

  // Posts que sumiram das listagens: confirma um a um (dentro do orçamento da execução).
  for (const job of individualLookups.slice(0, 4)) {
    if (session.api.client.remainingBudget <= 2) break;
    try {
      const post = await session.api.post(job.buffer_post_id!);
      if (post) applyPost(env, job, post, now, runId, stmts, summary, 'reconcile', null);
      else {
        const reason = 'O post não existe mais no Buffer (removido fora do app). Reenvie ou cancele.';
        stmts.push(
          env.DB.prepare(
            `UPDATE publication_jobs SET state = 'needs_attention', attention_reason = ?, buffer_status = 'deleted', updated_at = ? WHERE id = ?`,
          ).bind(reason, nowS, job.id),
          attemptStatement(env.DB, job.id, 'reconcile', 'error', reason, null, runId, now),
        );
        summary.reconciled++;
      }
    } catch (e) {
      if (!handleBufferError(e, summary, now, stmts, env)) break;
    }
  }

  // Ocupação real por canal.
  for (const c of channels) {
    const used = occupancyByChannel.get(c.external_id!) ?? 0;
    stmts.push(
      env.DB.prepare('UPDATE social_channels SET buffer_scheduled_count = ?, last_synced_at = ?, updated_at = ? WHERE id = ?').bind(
        used,
        nowS,
        nowS,
        c.id,
      ),
    );
  }
  await flushStatements(env, stmts);

  // 4) Abastecimento.
  const free = new Map<number, number>();
  for (const c of channels) {
    const used = occupancyByChannel.get(c.external_id!) ?? 0;
    const unavailable = bool(c.is_disconnected)
      ? 'Canal desconectado no Buffer.'
      : bool(c.is_locked)
        ? 'Canal bloqueado no Buffer (limite do plano).'
        : bool(c.is_queue_paused)
          ? 'Fila pausada no Buffer.'
          : null;
    const freeSlots = unavailable || !occupancyComplete ? 0 : Math.max(0, c.queue_limit - used);
    free.set(c.id, freeSlots);
    summary.occupancy.push({
      platform: c.platform,
      channelId: c.id,
      name: c.name,
      used: occupancyComplete ? used : null,
      limit: c.queue_limit,
      free: occupancyComplete ? Math.max(0, c.queue_limit - used) : null,
      available: !unavailable,
      reason: unavailable,
    });
  }
  if (!occupancyComplete) summary.notes.push('A lista de posts do Buffer veio incompleta; nada foi criado por segurança.');
  if (opts.syncOnly) return;
  if (settings.autofillPaused) {
    summary.notes.push('Abastecimento automático pausado.');
    return;
  }
  const totalFree = [...free.values()].reduce((a, b) => a + b, 0);
  if (totalFree === 0) return;

  const minStart = new Date(now.getTime() + settings.minLeadMinutes * 60_000).toISOString();
  // Só redes com vaga; o limite é por rede (cada uma pega no máximo as suas vagas, na ordem da história).
  const openPlatforms = channels.filter((c) => (free.get(c.id) ?? 0) > 0).map((c) => c.platform);
  const candidates = await all<JobForPublishing>(
    env.DB,
    `${JOB_FOR_PUBLISHING_SELECT}
     WHERE j.id IN (
       SELECT id FROM (
         SELECT id, platform, ROW_NUMBER() OVER (PARTITION BY platform ORDER BY scheduled_at ASC, id ASC) AS rn
         FROM publication_jobs
         WHERE state = 'planned' AND platform IN (${placeholders(openPlatforms.length)}) AND scheduled_at >= ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ) WHERE rn <= ?)
     ORDER BY j.scheduled_at ASC, j.id ASC`,
    ...openPlatforms,
    minStart,
    nowS,
    Math.max(...openPlatforms.map((p) => free.get(byPlatform.get(p)!.id) ?? 0)),
  );

  let unknownOutcomes = 0;
  for (const job of candidates) {
    if (summary.created + summary.dryRun >= settings.maxCreatesPerRun) {
      summary.notes.push(`Limite de ${settings.maxCreatesPerRun} envios por execução atingido; o restante fica para a próxima.`);
      break;
    }
    const channel = byPlatform.get(job.platform);
    if (!channel) continue;
    if ((free.get(channel.id) ?? 0) <= 0) continue;
    if (session.api.client.remainingBudget <= 0) {
      summary.notes.push('Orçamento de requisições desta execução esgotado.');
      break;
    }

    const url = job.m_id && job.m_token && job.m_key ? mediaUrl(env, { id: job.m_id, public_token: job.m_token, r2_key: job.m_key }, publicOrigin) : null;
    const problems = publishingProblems(job, url);
    if (problems.length > 0) {
      const message = problems.join(' ');
      await env.DB.batch([
        env.DB.prepare(`UPDATE publication_jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND state = 'planned'`).bind(
          message,
          nowS,
          job.id,
        ),
        attemptStatement(env.DB, job.id, 'create', 'error', message, { validation: problems }, runId, now),
      ]);
      summary.failed++;
      continue;
    }
    const input = buildCreatePostInput(job, channel.external_id!, url!, settings);
    const warnings = publishingWarnings(job);

    if (settings.dryRun) {
      await env.DB.batch([
        env.DB.prepare('UPDATE publication_jobs SET dry_run_checked_at = ?, updated_at = ? WHERE id = ?').bind(nowS, nowS, job.id),
        attemptStatement(
          env.DB,
          job.id,
          'dry_run',
          'dry_run',
          'Simulação: este post seria criado no Buffer agora. Nada foi enviado.',
          { channelId: input.channelId, dueAt: input.dueAt, metadata: input.metadata ?? null, textLength: input.text.length, warnings },
          runId,
          now,
        ),
      ]);
      free.set(channel.id, (free.get(channel.id) ?? 0) - 1);
      summary.dryRun++;
      continue;
    }

    // Troca atômica planned -> creating: duas execuções nunca enviam a mesma publicação.
    const claimed = await run(
      env.DB,
      `UPDATE publication_jobs SET state = 'creating', create_started_at = ?, channel_id = ?, attempt_count = attempt_count + 1,
         last_error = NULL, updated_at = ? WHERE id = ? AND state = 'planned' AND buffer_post_id IS NULL`,
      nowS,
      channel.id,
      nowS,
      job.id,
    );
    if ((claimed.meta.changes ?? 0) !== 1) continue;

    try {
      const result = await session.api.createPost(input);
      if (result.ok) {
        const p = result.post;
        const note =
          p.schedulingType === 'notification'
            ? 'Agendado como LEMBRETE no Buffer (não é publicação automática): você receberá uma notificação para publicar.'
            : 'Agendado no Buffer. Ainda não publicado na rede.';
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE publication_jobs SET state = 'scheduled_buffer', buffer_post_id = ?, buffer_status = ?, buffer_due_at = ?,
               buffer_scheduling_type = ?, next_attempt_at = NULL, attention_reason = NULL, updated_at = ? WHERE id = ?`,
          ).bind(p.id, p.status, p.dueAt, p.schedulingType, nowS, job.id),
          attemptStatement(env.DB, job.id, 'create', 'success', note, { bufferPostId: p.id, dueAt: p.dueAt, warnings }, runId, now),
        ]);
        free.set(channel.id, (free.get(channel.id) ?? 0) - 1);
        summary.created++;
      } else if (result.limitReached) {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE publication_jobs SET state = 'planned', create_started_at = NULL, attempt_count = MAX(attempt_count - 1, 0), updated_at = ? WHERE id = ?`,
          ).bind(nowS, job.id),
          attemptStatement(env.DB, job.id, 'create', 'error', `Fila cheia no Buffer: ${result.message}`, { typename: result.typename }, runId, now),
        ]);
        free.set(channel.id, 0);
        summary.limitHits++;
      } else {
        const transient = result.typename === 'UnexpectedError' || result.typename === 'RestProxyError';
        const exhausted = job.attempt_count + 1 >= settings.maxRetryAttempts;
        if (transient && !exhausted) {
          const next = new Date(now.getTime() + backoffMinutes(job.attempt_count + 1) * 60_000).toISOString();
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE publication_jobs SET state = 'planned', create_started_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
            ).bind(result.message, next, nowS, job.id),
            attemptStatement(env.DB, job.id, 'create', 'error', `${result.message} Nova tentativa após ${next}.`, { typename: result.typename }, runId, now),
          ]);
        } else {
          await env.DB.batch([
            env.DB.prepare(`UPDATE publication_jobs SET state = 'failed', create_started_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`).bind(
              result.message,
              nowS,
              job.id,
            ),
            attemptStatement(env.DB, job.id, 'create', 'error', result.message, { typename: result.typename }, runId, now),
          ]);
          summary.failed++;
        }
      }
    } catch (e) {
      if (e instanceof BufferError && e.outcomeUnknown) {
        // Resultado desconhecido: fica em "creating" para a recuperação conferir no Buffer antes de repetir.
        await env.DB.batch([
          env.DB.prepare(`UPDATE publication_jobs SET last_error = ?, updated_at = ? WHERE id = ?`).bind(e.message, nowS, job.id),
          attemptStatement(env.DB, job.id, 'create', 'unknown', `${e.message} O app vai conferir no Buffer antes de tentar de novo.`, null, runId, now),
        ]);
        unknownOutcomes++;
        if (unknownOutcomes >= 2) {
          summary.notes.push('Erro: falhas de comunicação seguidas com o Buffer; envios interrompidos nesta execução.');
          break;
        }
        continue;
      }
      // Erro sem efeito no Buffer (limite, autenticação, orçamento): devolve à fila.
      const stmtsErr: D1PreparedStatement[] = [
        env.DB.prepare(
          `UPDATE publication_jobs SET state = 'planned', create_started_at = NULL, attempt_count = MAX(attempt_count - 1, 0), updated_at = ? WHERE id = ?`,
        ).bind(nowS, job.id),
        attemptStatement(env.DB, job.id, 'create', 'error', (e as Error).message, null, runId, now),
      ];
      handleBufferError(e, summary, now, stmtsErr, env);
      await env.DB.batch(stmtsErr);
      break;
    }
  }
}

function applyPost(
  env: Env,
  job: JobRow,
  post: BufferPost,
  now: Date,
  runId: number | null,
  stmts: D1PreparedStatement[],
  summary: RunSummary,
  kind: 'reconcile' | 'recover',
  message: string | null,
): void {
  const mapped = mapBufferPost(post, now);
  const nowS = now.toISOString();
  const changed =
    job.state !== mapped.state ||
    job.buffer_post_id !== post.id ||
    job.buffer_status !== post.status ||
    !sameInstant(job.buffer_due_at, post.dueAt) ||
    (job.buffer_scheduling_type ?? null) !== (post.schedulingType ?? null);
  if (!changed) return;
  stmts.push(
    env.DB.prepare(
      `UPDATE publication_jobs SET state = ?, buffer_post_id = ?, buffer_status = ?, buffer_due_at = ?, buffer_scheduling_type = ?,
         published_at = COALESCE(?, published_at), external_url = COALESCE(?, external_url),
         last_error = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error END,
         attention_reason = ?, create_started_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).bind(
      mapped.state,
      post.id,
      post.status,
      post.dueAt,
      post.schedulingType,
      mapped.state === 'published' ? (post.sentAt ?? nowS) : null,
      post.externalLink,
      mapped.error,
      mapped.error,
      mapped.reason,
      nowS,
      job.id,
    ),
  );
  if (job.state !== mapped.state || message) {
    stmts.push(
      attemptStatement(
        env.DB,
        job.id,
        kind,
        mapped.state === 'failed' ? 'error' : 'success',
        message ?? `Buffer: ${post.status}${mapped.error ? ` (${mapped.error})` : ''}.`,
        { bufferPostId: post.id, status: post.status, sentAt: post.sentAt, externalLink: post.externalLink },
        runId,
        now,
      ),
    );
  }
  summary.reconciled++;
}

/** Trata erros do Buffer. Devolve true se é seguro continuar a execução. */
function handleBufferError(e: unknown, summary: RunSummary, now: Date, stmts: D1PreparedStatement[], env: Env): boolean {
  if (!(e instanceof BufferError)) throw e;
  if (e.kind === 'rate_limited') {
    const wait = Math.max(60, e.options.retryAfterSeconds ?? 900);
    const until = new Date(now.getTime() + wait * 1000).toISOString();
    stmts.push(statement(env, 'buffer_backoff_until', until));
    summary.notes.push(`Erro: limite de requisições do Buffer (${e.options.window ?? 'janela desconhecida'}). Pausa até ${until}.`);
    return false;
  }
  if (e.kind === 'unauthorized' || e.kind === 'forbidden') {
    summary.notes.push(`Erro: ${e.message}`);
    return false;
  }
  if (e.kind === 'budget') {
    summary.notes.push('Orçamento de requisições desta execução esgotado.');
    return false;
  }
  summary.notes.push(`Erro: ${e.message}`);
  return e.kind === 'not_found';
}

async function flushStatements(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length === 0) return;
  // D1 aceita lotes grandes, mas fatiamos para manter cada transação curta.
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  stmts.length = 0;
}

export type { BufferPlatform };
