import type { Platform } from './constants';
import { addDays, isValidDate, isValidTime, zonedToUtc } from './time';

export interface CalendarConfig {
  startDate: string; // AAAA-MM-DD no fuso configurado
  days: number;
  times: string[]; // HH:MM
  timeZone: string;
  /** Antecedência mínima entre agora e o primeiro horário aceito. */
  minLeadMinutes: number;
}

export interface PlanEpisode {
  id: number;
  label: string;
  /** Redes em que o episódio deve sair (já filtradas pelas redes escolhidas no gerador). */
  platforms: Platform[];
}

export interface ExistingJob {
  episodeId: number;
  platform: Platform;
  scheduledAt: string; // ISO UTC
}

export interface Slot {
  index: number;
  date: string;
  time: string;
  scheduledAt: string; // ISO UTC
}

export interface PlanItem {
  episodeId: number;
  label: string;
  slot: Slot;
  platforms: Platform[];
  reusedExistingTime: boolean;
}

export interface PlanSkip {
  episodeId: number;
  label: string;
  reason: string;
}

export interface CalendarPlan {
  slots: Slot[];
  items: PlanItem[];
  skipped: PlanSkip[];
  pastSlots: number;
  occupiedSlots: number;
  freeSlotsLeft: number;
}

export function validateCalendarConfig(cfg: CalendarConfig): string[] {
  const errors: string[] = [];
  if (!isValidDate(cfg.startDate)) errors.push('Data inicial inválida.');
  if (!Number.isInteger(cfg.days) || cfg.days < 1 || cfg.days > 120) errors.push('Quantidade de dias deve ficar entre 1 e 120.');
  if (cfg.times.length < 1 || cfg.times.length > 12) errors.push('Informe de 1 a 12 horários por dia.');
  for (const t of cfg.times) if (!isValidTime(t)) errors.push(`Horário inválido: ${t}`);
  if (new Set(cfg.times).size !== cfg.times.length) errors.push('Há horários repetidos.');
  return errors;
}

/** Horários da agenda automática: "12:00", 2 por dia, 8 h de intervalo viram 12:00 e 20:00. */
export function autoTimes(firstTime: string, perDay: number, intervalHours: number): string[] {
  const [h, m] = firstTime.split(':').map(Number) as [number, number];
  const lastHour = h + (perDay - 1) * intervalHours;
  if (lastHour >= 24) throw new Error(`${perDay} posts com ${intervalHours} h de intervalo a partir de ${firstTime} passam da meia-noite.`);
  return Array.from({ length: perDay }, (_, i) => `${String(h + i * intervalHours).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

export interface PullJob {
  id: number;
  episodeId: number;
  label: string;
  platform: Platform;
  scheduledAt: string; // ISO UTC
}

export interface PullMove {
  jobId: number;
  episodeId: number;
  label: string;
  platform: Platform;
  from: string;
  to: string;
}

/**
 * Antecipa um episódio e fecha o buraco: cada horário depois dele herda o horário anterior.
 * O que vem antes não muda. A lista sai em ordem crescente, a ordem segura para gravar:
 * cada horário de destino já foi liberado quando chega a vez dele.
 */
export function planPull(
  movable: PullJob[],
  fixed: { platform: Platform; scheduledAt: string }[],
  episodeId: number,
  target: string,
): PullMove[] {
  const picked = movable.filter((j) => j.episodeId === episodeId);
  if (picked.length === 0) throw new Error('Este episódio não tem publicações que possam ser movidas.');
  const from = picked.map((j) => j.scheduledAt).sort()[0]!;
  if (target >= from) throw new Error('O novo horário precisa ser antes do horário atual do episódio.');

  const toMove = (j: PullJob, to: string): PullMove => ({ jobId: j.id, episodeId: j.episodeId, label: j.label, platform: j.platform, from: j.scheduledAt, to });
  const moves = picked.map((j) => toMove(j, target));
  const later = movable.filter((j) => j.episodeId !== episodeId && j.scheduledAt > from);
  let previous = from;
  for (const instant of [...new Set(later.map((j) => j.scheduledAt))].sort()) {
    for (const j of later.filter((l) => l.scheduledAt === instant)) moves.push(toMove(j, previous));
    previous = instant;
  }

  const staying = movable.filter((j) => j.episodeId !== episodeId && j.scheduledAt <= from);
  const blocked = new Set([...fixed, ...staying].map((j) => `${j.platform}@${j.scheduledAt}`));
  const clash = moves.find((m) => blocked.has(`${m.platform}@${m.to}`));
  if (clash) throw new Error(`O horário de destino de ${clash.label} já está ocupado.`);
  return moves;
}

export function buildSlots(cfg: CalendarConfig): Slot[] {
  const times = [...cfg.times].sort();
  const slots: Slot[] = [];
  for (let d = 0; d < cfg.days; d++) {
    const date = addDays(cfg.startDate, d);
    for (const time of times) {
      slots.push({ index: slots.length, date, time, scheduledAt: zonedToUtc(date, time, cfg.timeZone).toISOString() });
    }
  }
  return slots;
}

/**
 * Distribui episódios (já ordenados) pelos horários livres, um episódio por horário,
 * criando uma publicação por rede. Nunca repete (episódio, rede) já existente e nunca
 * usa um horário já ocupado por outro episódio, preservando a sequência da história.
 */
export function planCalendar(
  cfg: CalendarConfig,
  episodes: PlanEpisode[],
  existing: ExistingJob[],
  now: Date,
): CalendarPlan {
  const errors = validateCalendarConfig(cfg);
  if (errors.length) throw new Error(errors.join(' '));

  const minStart = now.getTime() + cfg.minLeadMinutes * 60_000;
  const allSlots = buildSlots(cfg);
  const occupiedInstants = new Set(existing.map((j) => j.scheduledAt));
  const existingByEpisode = new Map<number, ExistingJob[]>();
  for (const j of existing) {
    const list = existingByEpisode.get(j.episodeId) ?? [];
    list.push(j);
    existingByEpisode.set(j.episodeId, list);
  }
  const takenPlatformInstant = new Set(existing.map((j) => `${j.platform}@${j.scheduledAt}`));

  let pastSlots = 0;
  let occupiedSlots = 0;
  const free: Slot[] = [];
  for (const s of allSlots) {
    if (new Date(s.scheduledAt).getTime() < minStart) pastSlots++;
    else if (occupiedInstants.has(s.scheduledAt)) occupiedSlots++;
    else free.push(s);
  }

  const items: PlanItem[] = [];
  const skipped: PlanSkip[] = [];
  let cursor = 0;

  for (const ep of episodes) {
    const already = existingByEpisode.get(ep.id) ?? [];
    const alreadyPlatforms = new Set(already.map((j) => j.platform));
    const missing = ep.platforms.filter((p) => !alreadyPlatforms.has(p));
    if (ep.platforms.length === 0) {
      skipped.push({ episodeId: ep.id, label: ep.label, reason: 'Nenhuma rede selecionada para este episódio.' });
      continue;
    }
    if (missing.length === 0) {
      skipped.push({ episodeId: ep.id, label: ep.label, reason: 'Já está programado em todas as redes escolhidas.' });
      continue;
    }

    if (already.length > 0) {
      // Episódio já tem horário em outra rede: as redes que faltam entram no mesmo horário.
      const anchor = [...already].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0]!;
      const anchorTime = new Date(anchor.scheduledAt).getTime();
      const usable = missing.filter((p) => !takenPlatformInstant.has(`${p}@${anchor.scheduledAt}`));
      if (anchorTime < minStart) {
        skipped.push({ episodeId: ep.id, label: ep.label, reason: 'O horário já usado por este episódio passou; reagende manualmente.' });
      } else if (usable.length === 0) {
        skipped.push({ episodeId: ep.id, label: ep.label, reason: 'Horário do episódio já ocupado nas redes que faltam.' });
      } else {
        const slot = allSlots.find((s) => s.scheduledAt === anchor.scheduledAt) ?? {
          index: -1,
          date: '',
          time: '',
          scheduledAt: anchor.scheduledAt,
        };
        items.push({ episodeId: ep.id, label: ep.label, slot, platforms: usable, reusedExistingTime: true });
        for (const p of usable) takenPlatformInstant.add(`${p}@${anchor.scheduledAt}`);
      }
      continue;
    }

    const slot = free[cursor];
    if (!slot) {
      skipped.push({ episodeId: ep.id, label: ep.label, reason: 'Sem horário livre no período escolhido.' });
      continue;
    }
    cursor++;
    items.push({ episodeId: ep.id, label: ep.label, slot, platforms: missing, reusedExistingTime: false });
    for (const p of missing) takenPlatformInstant.add(`${p}@${slot.scheduledAt}`);
  }

  return {
    slots: allSlots,
    items,
    skipped,
    pastSlots,
    occupiedSlots,
    freeSlotsLeft: free.length - cursor,
  };
}
