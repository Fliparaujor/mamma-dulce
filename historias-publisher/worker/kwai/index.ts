// Módulo Kwai. A Kuaishou Open Platform (open.kuaishou.com) tem escopo de publicação (user_video_publish),
// mas não foi confirmado que ela atenda contas do Kwai no Brasil. Sem essa confirmação, o fluxo é manual e assistido:
// fila do dia, legenda pronta, vídeo para baixar/compartilhar e confirmação explícita do administrador.
// Nada é marcado como publicado sem essa confirmação. Para integrar uma API oficial no futuro,
// implemente um "provider" com a mesma interface de listagem/confirmação.
import { localDate, localTime } from '../../shared/time';
import { all } from '../lib/db';
import { jobCaption, JOB_FOR_PUBLISHING_SELECT, type JobForPublishing } from '../scheduler/jobs';
import { mediaPath } from '../services/media';
import type { Env } from '../env';

export const KWAI_WEB_URL = 'https://www.kwai.com/';

export interface KwaiQueueItem {
  jobId: number;
  episodeId: number;
  title: string;
  seriesTitle: string;
  episodeNumber: number;
  scheduledAt: string;
  localDate: string;
  localTime: string;
  state: string;
  caption: string;
  mediaPath: string | null;
  mediaFilename: string | null;
  confirmedAt: string | null;
  note: string | null;
}

function toItem(j: JobForPublishing & { m_filename?: string | null; manual_note?: string | null }, tz: string): KwaiQueueItem {
  return {
    jobId: j.id,
    episodeId: j.episode_id,
    title: j.episode_title,
    seriesTitle: j.series_title,
    episodeNumber: j.episode_number,
    scheduledAt: j.scheduled_at,
    localDate: localDate(j.scheduled_at, tz),
    localTime: localTime(j.scheduled_at, tz),
    state: j.state,
    caption: jobCaption(j),
    mediaPath:
      j.m_id && j.m_token && j.m_key && j.m_status === 'ready' ? mediaPath({ id: j.m_id, public_token: j.m_token, r2_key: j.m_key }) : null,
    mediaFilename: j.m_filename ?? null,
    confirmedAt: j.manual_confirmed_at,
    note: j.manual_note ?? null,
  };
}

export async function kwaiQueue(env: Env, tz: string, now: Date, horizonDays = 7): Promise<{ pending: KwaiQueueItem[]; upcoming: KwaiQueueItem[]; history: KwaiQueueItem[] }> {
  const horizon = new Date(now.getTime() + horizonDays * 24 * 3600_000).toISOString();
  const rows = await all<JobForPublishing & { m_filename: string | null }>(
    env.DB,
    `${JOB_FOR_PUBLISHING_SELECT.replace('m.height AS m_height', 'm.height AS m_height, m.original_filename AS m_filename')}
     WHERE j.platform = 'kwai' AND (
       (j.state IN ('planned', 'manual_pending', 'needs_attention') AND j.scheduled_at <= ?)
       OR (j.state = 'published' AND j.published_at >= ?))
     ORDER BY j.scheduled_at ASC`,
    horizon,
    new Date(now.getTime() - 30 * 24 * 3600_000).toISOString(),
  );
  const items = rows.map((r) => toItem(r, tz));
  const today = localDate(now, tz);
  return {
    pending: items.filter((i) => i.state !== 'published' && (i.state === 'manual_pending' || i.localDate <= today)),
    upcoming: items.filter((i) => i.state !== 'published' && i.state !== 'manual_pending' && i.localDate > today),
    history: items.filter((i) => i.state === 'published').reverse(),
  };
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Dobra linhas em 75 octetos como pede a RFC 5545. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ' ' + rest.slice(73);
  }
  out.push(rest);
  return out.join('\r\n');
}

/**
 * Calendário iCalendar com as publicações manuais do Kwai e alarme antes do horário.
 * Assinável no Google Agenda do Android: lembrete gratuito sem push próprio.
 */
export async function kwaiIcs(env: Env, baseUrl: string, reminderMinutes: number, now: Date): Promise<string> {
  const rows = await all<JobForPublishing>(
    env.DB,
    `${JOB_FOR_PUBLISHING_SELECT}
     WHERE j.platform = 'kwai' AND j.state IN ('planned', 'manual_pending', 'needs_attention') AND j.scheduled_at >= ?
     ORDER BY j.scheduled_at ASC LIMIT 200`,
    new Date(now.getTime() - 2 * 24 * 3600_000).toISOString(),
  );
  const stamp = icsDate(now.toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Historias Publisher//Kwai//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Kwai · publicações manuais',
  ];
  for (const j of rows) {
    const start = icsDate(new Date(j.scheduled_at).toISOString());
    const end = icsDate(new Date(new Date(j.scheduled_at).getTime() + 15 * 60_000).toISOString());
    const caption = jobCaption(j);
    lines.push(
      'BEGIN:VEVENT',
      `UID:kwai-job-${j.id}@historias-publisher`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      fold(`SUMMARY:${icsEscape(`Kwai: ${j.series_title} · Ep. ${j.episode_number}`)}`),
      fold(`DESCRIPTION:${icsEscape(`Abra o painel para baixar o vídeo e copiar a legenda:\n${baseUrl}/publicacoes?aba=kwai\n\nLegenda:\n${caption}`)}`),
      fold(`URL:${baseUrl}/publicacoes?aba=kwai`),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      fold(`DESCRIPTION:${icsEscape(`Publicar no Kwai: ${j.episode_title}`)}`),
      `TRIGGER:-PT${Math.max(0, reminderMinutes)}M`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
