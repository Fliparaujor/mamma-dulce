import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABEL } from '@shared/constants';
import { localDate, localTime } from '@shared/time';
import { CalendarClock, ExternalLink, RotateCcw, XCircle } from 'lucide-react';
import * as React from 'react';
import { Notice, PlatformMark, StateBadge } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, post } from '@/lib/api';
import type { Attempt, Job } from '@/lib/types';
import { cn, formatDateTime } from '@/lib/utils';

const KIND_LABEL: Record<string, string> = {
  create: 'Envio ao Buffer',
  recover: 'Recuperação',
  reconcile: 'Sincronização',
  edit: 'Reagendamento',
  delete: 'Cancelamento',
  manual_confirm: 'Confirmação manual',
  manual_undo: 'Confirmação desfeita',
  retry: 'Reprocessamento',
  dry_run: 'Simulação',
  state_change: 'Mudança de estado',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

export function JobSheet({ jobId, timezone, onClose }: { jobId: number | null; timezone: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api<{ job: Job; attempts: Attempt[] }>(`/api/jobs/${jobId}`),
    enabled: jobId !== null,
  });
  const [date, setDate] = React.useState('');
  const [time, setTime] = React.useState('');

  React.useEffect(() => {
    if (data?.job) {
      setDate(localDate(data.job.scheduledAt, timezone));
      setTime(localTime(data.job.scheduledAt, timezone));
    }
  }, [data?.job, timezone]);

  const done = (msg: string) => {
    void qc.invalidateQueries();
    toast.success(msg);
  };
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body ?? {}),
    onError: (e: Error) => toast.error('Ação não concluída', e.message),
  });

  const job = data?.job;
  const busy = action.isPending;
  const canReschedule = job && !['published', 'cancelled', 'creating'].includes(job.state);
  const canCancel = job && !['published', 'cancelled', 'creating'].includes(job.state);
  const canRetry = job && ['failed', 'needs_attention'].includes(job.state);

  return (
    <Dialog open={jobId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={job ? job.episodeTitle : 'Publicação'} description={job ? `${job.seriesTitle} · ${PLATFORM_LABEL[job.platform]}` : undefined}>
        {!job ? (
          <p className="text-sm text-muted">Carregando…</p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <PlatformMark platform={job.platform} />
              <StateBadge state={job.state} />
            </div>

            {job.attentionReason && <Notice tone="warning">{job.attentionReason}</Notice>}
            {job.lastError && <Notice tone="danger">{job.lastError}</Notice>}
            {job.state === 'scheduled_buffer' && (
              <Notice tone="info">Criado no Buffer. Isso não significa que já foi publicado na rede; a confirmação chega na próxima sincronização depois do horário.</Notice>
            )}

            <div className="divide-y divide-border rounded-lg border border-border px-3">
              <Row label="Horário planejado">{formatDateTime(job.scheduledAt, timezone, { weekday: 'short', year: 'numeric' })}</Row>
              <Row label="Publicado em">{job.publishedAt ? formatDateTime(job.publishedAt, timezone, { year: 'numeric' }) : '—'}</Row>
              <Row label="Status no Buffer">{job.bufferStatus ?? '—'}</Row>
              <Row label="Tipo no Buffer">
                {job.bufferSchedulingType === 'notification' ? 'Lembrete (publicação manual)' : job.bufferSchedulingType === 'automatic' ? 'Automática' : '—'}
              </Row>
              <Row label="ID remoto">
                <code className="text-xs">{job.bufferPostId ?? '—'}</code>
              </Row>
              <Row label="Tentativas">{job.attemptCount}</Row>
              {job.externalUrl && (
                <Row label="Link">
                  <a href={job.externalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                    Abrir <ExternalLink className="size-3" />
                  </a>
                </Row>
              )}
            </div>

            {canReschedule && (
              <div className="rounded-lg border border-border p-3">
                <p className="mb-3 text-sm font-medium">Reagendar</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Data">
                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </Field>
                  <Field label={`Hora (${timezone.split('/')[1]?.replace('_', ' ') ?? timezone})`}>
                    <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                  </Field>
                </div>
                <Button
                  className="mt-3 w-full"
                  variant="secondary"
                  loading={busy}
                  onClick={() =>
                    action.mutate({ path: `/api/jobs/${job.id}/reschedule`, body: { date, time } }, { onSuccess: () => done('Publicação reagendada') })
                  }
                >
                  <CalendarClock />
                  Salvar novo horário
                </Button>
                {job.state === 'scheduled_buffer' && <p className="mt-2 text-xs text-muted">O horário também é alterado no Buffer.</p>}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {canRetry && (
                <Button variant="secondary" loading={busy} onClick={() => action.mutate({ path: `/api/jobs/${job.id}/retry` }, { onSuccess: () => done('Devolvida à fila') })}>
                  <RotateCcw />
                  Reprocessar com segurança
                </Button>
              )}
              {canCancel && (
                <Button
                  variant="outline"
                  className="text-danger"
                  loading={busy}
                  onClick={() => {
                    if (window.confirm('Cancelar esta publicação? Se estiver no Buffer, ela será removida de lá.')) {
                      action.mutate({ path: `/api/jobs/${job.id}/cancel` }, { onSuccess: () => done('Publicação cancelada') });
                    }
                  }}
                >
                  <XCircle />
                  Cancelar publicação
                </Button>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">Histórico</p>
              {data.attempts.length === 0 ? (
                <p className="text-sm text-muted">Nenhum registro ainda.</p>
              ) : (
                <ol className="relative ml-1.5 border-l border-border">
                  {data.attempts.map((a) => (
                    <li key={a.id} className="mb-3 ml-4">
                      <span
                        className={cn(
                          'absolute -left-[5px] mt-1.5 size-2.5 rounded-full',
                          a.outcome === 'success' ? 'bg-success' : a.outcome === 'error' ? 'bg-danger' : a.outcome === 'unknown' ? 'bg-warning' : 'bg-border-strong',
                        )}
                      />
                      <p className="text-xs text-muted">
                        {formatDateTime(a.created_at, timezone, { second: '2-digit' })} · {KIND_LABEL[a.kind] ?? a.kind}
                      </p>
                      <p className="text-sm">{a.message}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Dialog>
  );
}
