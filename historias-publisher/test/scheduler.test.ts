import { beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../worker/scheduler/lock';
import { CREATE_RECOVERY_GRACE_MS, runScheduler } from '../worker/scheduler/run';
import { saveSettings } from '../worker/settings';
import type { FakeBuffer } from './fake-buffer';
import { configureBuffer, env, installFakeBuffer, jobsByState, resetDb, scheduleJobs, seedEpisodes } from './helpers';

const HOUR = 3600_000;
let fake: FakeBuffer;

async function jobRow(id: number) {
  return env.DB.prepare('SELECT * FROM publication_jobs WHERE id = ?').bind(id).first<Record<string, unknown>>();
}

async function setupMonth(episodes = 60, start = new Date(Date.now() + 2 * HOUR)) {
  const ids = await seedEpisodes(episodes);
  await scheduleJobs(ids, start);
  return ids;
}

beforeEach(async () => {
  await resetDb();
  fake = installFakeBuffer();
  await configureBuffer();
});

describe('fila inteligente: limite de 10 posts por canal', () => {
  it('com 60 episódios planejados, envia só 10 por canal e mantém o resto no D1', async () => {
    await setupMonth();
    await saveSettings(env, { maxCreatesPerRun: 20 });
    const r1 = await runScheduler(env, 'manual');
    const r2 = await runScheduler(env, 'manual');
    expect(r1.status).toBe('ok');
    expect(r1.summary.created + r2.summary.created).toBe(30);
    for (const ch of ['ch_ig', 'ch_tt', 'ch_yt']) expect(fake.activeCount(ch)).toBe(10);
    expect(fake.callsOf('CreatePost')).toBe(30); // nunca tentou além do limite
    expect(await jobsByState()).toEqual({ planned: 150, scheduled_buffer: 30 });
    // as 10 primeiras de cada rede, na ordem da história
    const ig = await env.DB.prepare(
      `SELECT e.episode_number FROM publication_jobs j JOIN episodes e ON e.id = j.episode_id
       WHERE j.platform = 'instagram' AND j.state = 'scheduled_buffer' ORDER BY j.scheduled_at`,
    ).all<{ episode_number: number }>();
    expect(ig.results!.map((r) => r.episode_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('conta posts criados fora do app na ocupação real do canal', async () => {
    await setupMonth(20);
    for (let i = 0; i < 4; i++) fake.addExternalPost('ch_ig', new Date(Date.now() + (100 + i) * HOUR).toISOString());
    await runScheduler(env, 'manual'); // até 20 envios por execução
    await runScheduler(env, 'manual');
    expect(fake.activeCount('ch_ig')).toBe(10);
    expect(fake.posts.filter((p) => p.channelId === 'ch_ig' && p.via === 'api')).toHaveLength(6);
    expect(fake.activeCount('ch_tt')).toBe(10);
  });

  it('respeita o limite de envios por execução', async () => {
    await setupMonth(10);
    await saveSettings(env, { maxCreatesPerRun: 4 });
    const r = await runScheduler(env, 'manual');
    expect(r.summary.created).toBe(4);
    expect(fake.callsOf('CreatePost')).toBe(4);
  });

  it('LimitReachedError zera as vagas do canal sem marcar falha', async () => {
    await setupMonth(5);
    fake.queueLimit = 2; // o Buffer real é a autoridade final, mesmo se a configuração local estiver errada
    const r = await runScheduler(env, 'manual');
    expect(r.summary.limitHits).toBe(3); // um por canal
    expect(fake.activeCount('ch_ig')).toBe(2);
    const states = await jobsByState();
    expect(states.failed ?? 0).toBe(0);
    expect(states.scheduled_buffer).toBe(6);
  });
});

describe('reposição automática e reconciliação', () => {
  it('quando posts são publicados, marca como publicados e repõe as vagas', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    await setupMonth(30, start);
    await runScheduler(env, 'manual');
    await runScheduler(env, 'manual');
    expect(fake.activeCount('ch_ig')).toBe(10);

    // O Buffer publica os 2 primeiros episódios (dia 1). Avançamos o relógio para depois deles.
    const later = new Date(start.getTime() + 8 * HOUR);
    fake.now = () => later;
    const sent = fake.publishDue(later);
    expect(sent).toHaveLength(6);

    const r = await runScheduler(env, 'manual', {}, { now: () => later });
    expect(r.summary.reconciled).toBe(6);
    expect(r.summary.created).toBe(6);
    expect(fake.activeCount('ch_ig')).toBe(10);
    const states = await jobsByState();
    expect(states.published).toBe(6);
    expect(states.scheduled_buffer).toBe(30);

    const published = await env.DB.prepare(`SELECT * FROM publication_jobs WHERE state = 'published' LIMIT 1`).first<Record<string, string>>();
    expect(published!.external_url).toMatch(/^https:\/\/social\.example\.com\//);
    expect(published!.published_at).toBeTruthy();
  });

  it('agendado no Buffer não é tratado como publicado', async () => {
    await setupMonth(1);
    await runScheduler(env, 'manual');
    const states = await jobsByState();
    expect(states.published ?? 0).toBe(0);
    expect(states.scheduled_buffer).toBe(3);
  });

  it('post com erro no Buffer vira "Falhou" com a mensagem do Buffer', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    await setupMonth(1, start);
    await runScheduler(env, 'manual');
    const later = new Date(start.getTime() + HOUR);
    for (const p of fake.posts) {
      p.status = 'error';
      p.error = { message: 'Instagram rejected the video format', supportUrl: null };
    }
    await runScheduler(env, 'manual', {}, { now: () => later });
    const row = await env.DB.prepare(`SELECT state, last_error FROM publication_jobs WHERE platform = 'instagram'`).first<{ state: string; last_error: string }>();
    expect(row).toEqual({ state: 'failed', last_error: 'Instagram rejected the video format' });
  });

  it('post removido manualmente do Buffer vira "Requer atenção" e não é recriado sozinho', async () => {
    await setupMonth(1);
    await runScheduler(env, 'manual');
    fake.posts = fake.posts.filter((p) => p.channelId !== 'ch_tt');
    await runScheduler(env, 'manual');
    const tt = await env.DB.prepare(`SELECT state, attention_reason FROM publication_jobs WHERE platform = 'tiktok'`).first<{ state: string; attention_reason: string }>();
    expect(tt!.state).toBe('needs_attention');
    expect(tt!.attention_reason).toMatch(/removido/);
    await runScheduler(env, 'manual');
    expect(fake.posts.filter((p) => p.channelId === 'ch_tt')).toHaveLength(0);
  });

  it('lembrete (schedulingType notification) vira ação manual depois do horário', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    await setupMonth(1, start);
    fake.schedulingTypeFor.ch_tt = 'notification';
    await runScheduler(env, 'manual');
    const created = await env.DB.prepare(`SELECT id FROM publication_jobs WHERE platform = 'tiktok'`).first<{ id: number }>();
    const attempts = await env.DB.prepare(`SELECT message FROM publication_attempts WHERE job_id = ?`).bind(created!.id).all<{ message: string }>();
    expect(attempts.results!.some((a) => /LEMBRETE/.test(a.message))).toBe(true);

    await runScheduler(env, 'manual', {}, { now: () => new Date(start.getTime() + 10 * 60_000) });
    const row = await jobRow(created!.id);
    expect(row!.state).toBe('manual_pending');
    expect(row!.buffer_scheduling_type).toBe('notification');
  });
});

describe('execuções repetidas e concorrência', () => {
  it('rodar o agendador várias vezes não duplica posts', async () => {
    await setupMonth(8);
    for (let i = 0; i < 4; i++) await runScheduler(env, 'manual');
    expect(fake.posts).toHaveLength(24);
    const ids = new Set(fake.posts.map((p) => `${p.channelId}@${p.dueAt}`));
    expect(ids.size).toBe(24);
    expect(fake.callsOf('CreatePost')).toBe(24);
  });

  it('uma segunda execução simultânea é recusada pela trava', async () => {
    await setupMonth(2);
    expect(await acquireLock(env, 'scheduler', 'outra-execucao', 60_000)).toBe(true);
    const r = await runScheduler(env, 'manual');
    expect(r.status).toBe('skipped');
    expect(r.summary.bufferPhase).toBe('locked');
    expect(fake.calls).toHaveLength(0);
  });

  it('trava expirada (execução que morreu) é retomada', async () => {
    await setupMonth(1);
    await acquireLock(env, 'scheduler', 'morta', 1_000, new Date(Date.now() - 60_000));
    const r = await runScheduler(env, 'manual');
    expect(r.summary.created).toBe(3);
  });

  it('o cron respeita o intervalo configurado', async () => {
    await setupMonth(1);
    await runScheduler(env, 'cron');
    const callsAfterFirst = fake.calls.length;
    const r = await runScheduler(env, 'cron', {}, { now: () => new Date(Date.now() + 15 * 60_000) });
    expect(r.summary.bufferPhase).toBe('not_due');
    expect(fake.calls.length).toBe(callsAfterFirst);
  });

  it('sincronização inteligente não gasta cota quando nada mudou', async () => {
    await setupMonth(1);
    await runScheduler(env, 'cron');
    const before = fake.calls.length;
    const r = await runScheduler(env, 'cron', {}, { now: () => new Date(Date.now() + 61 * 60_000) });
    expect(r.summary.bufferPhase).toBe('nothing_to_do');
    expect(fake.calls.length).toBe(before);
  });
});

describe('falhas de comunicação com o Buffer', () => {
  it('resposta perdida depois do Buffer criar o post: não duplica e recupera o ID', async () => {
    await setupMonth(1);
    fake.failNext('lostResponse', 'CreatePost');
    const r1 = await runScheduler(env, 'manual');
    expect(fake.posts).toHaveLength(3); // o Buffer criou os 3
    const creating = await env.DB.prepare(`SELECT * FROM publication_jobs WHERE state = 'creating'`).all();
    expect(creating.results).toHaveLength(1);
    expect(r1.summary.created).toBe(2);

    const r2 = await runScheduler(env, 'manual');
    expect(r2.summary.recovered).toBe(1);
    expect(fake.posts).toHaveLength(3); // nada recriado
    expect(await jobsByState()).toEqual({ scheduled_buffer: 3 });
    const recovered = await env.DB.prepare(`SELECT buffer_post_id FROM publication_jobs WHERE platform = 'instagram'`).first<{ buffer_post_id: string }>();
    expect(fake.posts.some((p) => p.id === recovered!.buffer_post_id)).toBe(true);
  });

  it('falha de rede antes de chegar ao Buffer: só reenvia depois da janela de segurança', async () => {
    await setupMonth(1);
    fake.failNext('network', 'CreatePost');
    await runScheduler(env, 'manual');
    expect(fake.posts).toHaveLength(2);
    // logo em seguida: ainda dentro da janela, não tenta de novo
    await runScheduler(env, 'manual');
    expect(fake.posts).toHaveLength(2);
    expect((await jobsByState()).creating).toBe(1);
    // depois da janela: volta para a fila e é criado uma única vez
    const later = new Date(Date.now() + CREATE_RECOVERY_GRACE_MS + 60_000);
    await runScheduler(env, 'manual', {}, { now: () => later });
    await runScheduler(env, 'manual', {}, { now: () => later });
    expect(fake.posts).toHaveLength(3);
    expect(await jobsByState()).toEqual({ scheduled_buffer: 3 });
  });

  it('erro 500 ao consultar: tenta de novo e segue; com falha persistente não cria nada', async () => {
    await setupMonth(1);
    fake.failNext('server500', 'GetPosts');
    const r1 = await runScheduler(env, 'manual');
    expect(r1.summary.created).toBe(3); // a nova tentativa da consulta funcionou

    await resetDb();
    fake = installFakeBuffer();
    await configureBuffer();
    await setupMonth(1);
    for (let i = 0; i < 3; i++) fake.failNext('server500', 'GetPosts');
    const r2 = await runScheduler(env, 'manual');
    expect(r2.summary.created).toBe(0);
    expect(fake.callsOf('CreatePost')).toBe(0);
    expect(r2.status).toBe('partial');
  });

  it('429 do Buffer pausa as chamadas até o Retry-After', async () => {
    await setupMonth(1);
    fake.failNext('rate429', 'GetPosts');
    const r1 = await runScheduler(env, 'manual');
    expect(r1.summary.notes.join(' ')).toMatch(/limite de requisições/i);
    const calls = fake.calls.length;
    const r2 = await runScheduler(env, 'manual');
    expect(r2.summary.bufferPhase).toBe('backoff');
    expect(fake.calls.length).toBe(calls);
    const after = new Date(Date.now() + 800_000);
    const r3 = await runScheduler(env, 'manual', {}, { now: () => after });
    expect(r3.summary.created).toBe(3);
  });

  it('chave inválida: nada é criado e o erro aparece no resumo', async () => {
    await setupMonth(1);
    fake.failNext('unauthorized');
    const r = await runScheduler(env, 'manual');
    expect(r.summary.created).toBe(0);
    expect(r.summary.notes.join(' ')).toMatch(/Chave da API do Buffer/);
  });

  it('teto diário de requisições bloqueia novas chamadas', async () => {
    await setupMonth(1);
    await saveSettings(env, { dailyBufferBudget: 10 });
    await env.DB.prepare(`INSERT INTO usage_daily (day, metric, value) VALUES (?, 'buffer_requests', 10)`)
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    const r = await runScheduler(env, 'manual');
    expect(r.summary.bufferPhase).toBe('budget');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('políticas de segurança do envio', () => {
  it('publicação atrasada nunca é enviada fora do horário', async () => {
    const ids = await seedEpisodes(1);
    await scheduleJobs(ids, new Date(Date.now() - HOUR));
    const r = await runScheduler(env, 'manual');
    expect(r.summary.late).toBe(3);
    expect(fake.callsOf('CreatePost')).toBe(0);
    expect(await jobsByState()).toEqual({ needs_attention: 3 });
  });

  it('política "pular atrasados" cancela com registro do motivo', async () => {
    await saveSettings(env, { latePolicy: 'skip' });
    const ids = await seedEpisodes(1);
    await scheduleJobs(ids, new Date(Date.now() - HOUR), ['instagram']);
    await runScheduler(env, 'manual');
    const row = await env.DB.prepare('SELECT state, attention_reason FROM publication_jobs').first<{ state: string; attention_reason: string }>();
    expect(row!.state).toBe('cancelled');
    expect(row!.attention_reason).toMatch(/pular atrasados/);
  });

  it('modo simulação (dry-run) registra o que seria enviado sem chamar createPost', async () => {
    await saveSettings(env, { dryRun: true });
    await setupMonth(2);
    const r = await runScheduler(env, 'manual');
    expect(r.summary.dryRun).toBe(6);
    expect(fake.callsOf('CreatePost')).toBe(0);
    expect(await jobsByState()).toEqual({ planned: 6 });
    const a = await env.DB.prepare(`SELECT outcome, message FROM publication_attempts WHERE kind = 'dry_run' LIMIT 1`).first<{ outcome: string; message: string }>();
    expect(a).toMatchObject({ outcome: 'dry_run', message: expect.stringMatching(/Simulação/) });
  });

  it('pausa do abastecimento mantém a reconciliação, mas não cria', async () => {
    await saveSettings(env, { autofillPaused: true });
    await setupMonth(1);
    const r = await runScheduler(env, 'manual');
    expect(r.summary.bufferPhase).toBe('executed');
    expect(fake.callsOf('GetPosts')).toBeGreaterThan(0);
    expect(fake.callsOf('CreatePost')).toBe(0);
  });

  it('episódio sem vídeo falha na validação sem chamar o Buffer', async () => {
    const ids = await seedEpisodes(1);
    await env.DB.prepare('UPDATE episodes SET media_asset_id = NULL').run();
    await scheduleJobs(ids, new Date(Date.now() + 2 * HOUR), ['instagram']);
    await runScheduler(env, 'manual');
    const row = await env.DB.prepare('SELECT state, last_error FROM publication_jobs').first<{ state: string; last_error: string }>();
    expect(row!.state).toBe('failed');
    expect(row!.last_error).toMatch(/sem vídeo/i);
    expect(fake.callsOf('CreatePost')).toBe(0);
  });

  it('envia Reel no Instagram e título/categoria no YouTube conforme a API', async () => {
    await setupMonth(1);
    await runScheduler(env, 'manual');
    const ig = fake.posts.find((p) => p.channelId === 'ch_ig')!.input as { metadata: unknown; assets: { video: { url: string } }[]; mode: string };
    expect(ig.metadata).toEqual({ instagram: { type: 'reel', shouldShareToFeed: true } });
    expect(ig.mode).toBe('customScheduled');
    expect(ig.assets[0]!.video.url).toMatch(/^https:\/\/publisher\.example\.com\/media\/[0-9a-f-]{36}\/tok_[0-9a-f]+\.mp4$/);
    const yt = fake.posts.find((p) => p.channelId === 'ch_yt')!.input as { metadata: { youtube: Record<string, unknown> } };
    expect(yt.metadata.youtube).toMatchObject({ title: 'Historia 01 · Episódio 1', categoryId: '24', privacy: 'public', madeForKids: false });
    const tt = fake.posts.find((p) => p.channelId === 'ch_tt')!.input as { metadata?: unknown };
    expect(tt.metadata).toBeUndefined();
  });
});
