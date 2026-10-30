// Conversões de fuso horário sem dependências externas.
// Regra do projeto: o banco guarda instantes em UTC; a interface mostra no fuso configurado.

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Diferença (ms) entre o relógio local do fuso e UTC no instante dado. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function isValidTime(time: string): boolean {
  return TIME_RE.test(time);
}

/**
 * Converte data e hora locais (no fuso informado) para um instante UTC.
 * Em horários inexistentes (salto de horário de verão) avança para o primeiro horário válido;
 * em horários repetidos escolhe a primeira ocorrência.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm || !isValidDate(date)) throw new Error(`Data/hora inválida: ${date} ${time}`);
  const localAsUtc = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  // Duas passadas resolvem qualquer fuso com uma transição por vez.
  let guess = localAsUtc - timeZoneOffsetMs(new Date(localAsUtc), timeZone);
  const offset2 = timeZoneOffsetMs(new Date(guess), timeZone);
  guess = localAsUtc - offset2;
  const check = zonedParts(new Date(guess), timeZone);
  const back = Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute);
  if (back !== localAsUtc) {
    // Horário inexistente (salto para frente): aplica o offset de antes do salto,
    // o que empurra o instante para depois da transição (02:30 vira 03:30).
    const before = localAsUtc - timeZoneOffsetMs(new Date(guess - 3 * 3600_000), timeZone);
    return new Date(before);
  }
  return new Date(guess);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Data local (AAAA-MM-DD) de um instante no fuso. */
export function localDate(instant: Date | string, timeZone: string): string {
  const p = zonedParts(typeof instant === 'string' ? new Date(instant) : instant, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Hora local (HH:MM) de um instante no fuso. */
export function localTime(instant: Date | string, timeZone: string): string {
  const p = zonedParts(typeof instant === 'string' ? new Date(instant) : instant, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Soma dias a uma data de calendário (AAAA-MM-DD), sem passar por fuso. */
export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Data inválida: ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function toIso(d: Date): string {
  return d.toISOString();
}

/** Dia da semana (0 = domingo) de uma data de calendário. */
export function weekday(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Data inválida: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

export function formatLocal(instant: string | Date, timeZone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...opts,
  }).format(typeof instant === 'string' ? new Date(instant) : instant);
}
