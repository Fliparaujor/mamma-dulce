import { z } from 'zod';
import { isValidTime, isValidTimeZone } from '../shared/time';
import { all, nowIso, run } from './lib/db';
import type { Env } from './env';

const timeString = z.string().refine(isValidTime, 'use o formato HH:MM');

export const settingsSchema = z.object({
  timezone: z.string().refine(isValidTimeZone, 'fuso horário desconhecido').default('America/Belem'),
  defaultTimes: z.array(timeString).min(1).max(12).default(['12:00', '19:00']),
  calendarDays: z.number().int().min(1).max(120).default(30),

  /** Pausa só o abastecimento da fila do Buffer; a reconciliação continua. */
  autofillPaused: z.boolean().default(false),
  /** Simula o envio: valida e registra, mas não chama createPost. */
  dryRun: z.boolean().default(false),
  /** Intervalo mínimo entre execuções automáticas do agendador. */
  schedulerIntervalMinutes: z.number().int().min(15).max(24 * 60).default(60),
  /** Só consulta o Buffer quando algo pode ter mudado (economiza cota). */
  smartSync: z.boolean().default(true),
  maxCreatesPerRun: z.number().int().min(1).max(20).default(6),
  maxBufferRequestsPerRun: z.number().int().min(3).max(40).default(14),
  /** Teto diário de requisições ao Buffer feitas por este app (Free: 600/dia e 1.000 por canal a cada 30 dias). */
  dailyBufferBudget: z.number().int().min(10).max(5000).default(90),
  /** Antecedência mínima para enviar ao Buffer; abaixo disso a publicação é considerada atrasada. */
  minLeadMinutes: z.number().int().min(5).max(24 * 60).default(20),
  /** hold: marca "Requer atenção" e espera decisão. skip: cancela e registra o motivo. */
  latePolicy: z.enum(['hold', 'skip']).default('hold'),
  maxRetryAttempts: z.number().int().min(1).max(10).default(5),

  bufferOrganizationId: z.string().min(1).nullable().default(null),
  youtubeCategoryId: z.string().regex(/^\d{1,2}$/).default('24'),
  youtubePrivacy: z.enum(['public', 'unlisted', 'private']).default('public'),
  youtubeMadeForKids: z.boolean().default(false),
  youtubeNotifySubscribers: z.boolean().default(true),
  instagramShareToFeed: z.boolean().default(true),
  thumbnailOffsetMs: z.number().int().min(0).max(600_000).nullable().default(null),

  mediaRetentionDays: z.number().int().min(1).max(365).default(30),
  mediaAutoCleanup: z.boolean().default(false),
  kwaiReminderMinutes: z.number().int().min(0).max(24 * 60).default(30),
});

export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();

const SETTINGS_KEY = 'settings';

export async function getSettings(env: Env): Promise<Settings> {
  const rows = await all<{ value: string }>(env.DB, 'SELECT value FROM app_settings WHERE key = ?', SETTINGS_KEY);
  let stored: unknown = {};
  try {
    stored = rows[0] ? JSON.parse(rows[0].value) : {};
  } catch {
    stored = {};
  }
  const parsed = settingsSchema.safeParse(stored);
  if (parsed.success) {
    if (!rows[0] && env.APP_TIMEZONE && isValidTimeZone(env.APP_TIMEZONE)) parsed.data.timezone = env.APP_TIMEZONE;
    return parsed.data;
  }
  // Valor salvo inválido (versão antiga, edição manual): volta ao padrão campo a campo.
  const fallback = settingsSchema.parse({});
  const merged: Record<string, unknown> = { ...fallback };
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    const field = (settingsSchema.shape as Record<string, z.ZodType>)[k];
    if (field && field.safeParse(v).success) merged[k] = v;
  }
  return settingsSchema.parse(merged);
}

export async function saveSettings(env: Env, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(env);
  const next = settingsSchema.parse({ ...current, ...patch });
  await run(
    env.DB,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SETTINGS_KEY,
    JSON.stringify(next),
    nowIso(),
  );
  return next;
}

/** Valores internos (estado do agendador, cabeçalhos de cota etc.). */
export async function getState<T>(env: Env, key: string): Promise<T | null> {
  const rows = await all<{ value: string }>(env.DB, 'SELECT value FROM app_settings WHERE key = ?', `state:${key}`);
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value) as T;
  } catch {
    return null;
  }
}

export async function setState(env: Env, key: string, value: unknown): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    `state:${key}`,
    JSON.stringify(value),
    nowIso(),
  );
}

export function statement(env: Env, key: string, value: unknown): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(`state:${key}`, JSON.stringify(value), nowIso());
}

/** URL pública usada nas mídias enviadas ao Buffer. Precisa ser HTTPS e acessível pela internet. */
export function publicBaseUrl(env: Env, fallbackOrigin?: string | null): string | null {
  const candidate = (env.PUBLIC_BASE_URL || fallbackOrigin || '').replace(/\/+$/, '');
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:') return null;
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}
