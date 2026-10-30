import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABEL } from '@shared/constants';
import {
  ArrowUpRight,
  CalendarPlus,
  CircleAlert,
  CircleCheck,
  Clapperboard,
  Hand,
  HardDrive,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Send,
  Upload,
} from 'lucide-react';
import type * as React from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Notice, PageHeader, PlatformMark, stateDot } from '@/components/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress, Skeleton } from '@/components/ui/controls';
import { useToast } from '@/components/ui/toast';
import { api, post } from '@/lib/api';
import type { Dashboard, RunSummary } from '@/lib/types';
import { capitalizeFirst, cn, formatBytes, formatDateTime, formatRelative } from '@/lib/utils';

function Stat({ label, value, icon: Icon, tone, to }: { label: string; value: number; icon: React.ComponentType<{ className?: string }>; tone?: string; to: string }) {
  return (
    <Link to={to} className="group rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong">
      <div className="flex items-center justify-between">
        <Icon className={cn('size-4', tone ?? 'text-muted')} />
        <ArrowUpRight className="size-3.5 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <p className="mt-4 font-display text-4xl leading-none tabular">{value}</p>
      <p className="mt-1.5 text-[13px] text-muted">{label}</p>
    </Link>
  );
}

export function describeRun(s: RunSummary | null): string {
  if (!s) return 'Sem resumo.';
  const parts: string[] = [];
  if (s.created) parts.push(`${s.created} enviada(s) ao Buffer`);
  if (s.dryRun) parts.push(`${s.dryRun} simulada(s)`);
  if (s.reconciled) parts.push(`${s.reconciled} atualizada(s)`);
  if (s.recovered) parts.push(`${s.recovered} recuperada(s)`);
  if (s.late) parts.push(`${s.late} atrasada(s)`);
  if (s.failed) parts.push(`${s.failed} com falha`);
  if (parts.length === 0) parts.push('nenhuma mudança');
  return parts.join(' · ');
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/api/dashboard'), refetchInterval: 60_000 });

  const sync = useMutation({
    mutationFn: () => post<{ status: string; summary: RunSummary }>('/api/scheduler/run', { syncOnly: false }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      const notes = r.summary.notes.filter(Boolean);
      if (r.status === 'error') toast.error('O agendador encontrou um erro', notes.join(' '));
      else toast.success('Sincronização concluída', [describeRun(r.summary), ...notes].join(' — '));
    },
    onError: (e: Error) => toast.error('Falha ao sincronizar', e.message),
  });
  const retry = useMutation({
    mutationFn: () => post<{ results: { ok: boolean; error?: string }[] }>('/api/jobs/retry-failed'),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      const ok = r.results.filter((x) => x.ok).length;
      const fail = r.results.length - ok;
      if (r.results.length === 0) toast.info('Nenhuma publicação com erro');
      else toast.success(`${ok} devolvida(s) à fila`, fail ? `${fail} precisam ser reagendadas (horário já passou ou post ainda existe no Buffer).` : undefined);
    },
    onError: (e: Error) => toast.error('Falha ao reprocessar', e.message),
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  const s = data.counts.jobsByState;
  const upcoming = Object.values(
    data.upcoming.reduce<Record<string, { key: string; scheduledAt: string; episodeTitle: string; items: Dashboard['upcoming'] }>>((acc, u) => {
      const key = `${u.episodeTitle}@${u.scheduledAt}`;
      (acc[key] ??= { key, scheduledAt: u.scheduledAt, episodeTitle: u.episodeTitle, items: [] }).items.push(u);
      return acc;
    }, {}),
  );
  const tz = data.timezone;
  const today = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(data.now));

  return (
    <div className="animate-in">
      <PageHeader
        title="Visão geral"
        description={capitalizeFirst(today)}
        actions={
          <>
            <Button variant="secondary" onClick={() => sync.mutate()} loading={sync.isPending}>
              <RefreshCw />
              Sincronizar
            </Button>
            <Button asChild>
              <Link to="/biblioteca">
                <Upload />
                Enviar vídeos
              </Link>
            </Button>
          </>
        }
      />

      {data.warnings.length > 0 && (
        <div className="mb-6 grid gap-2">
          {data.warnings.map((w) => (
            <Notice key={w} tone="warning">
              {w}
            </Notice>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Episódios cadastrados" value={data.counts.episodes} icon={Clapperboard} to="/episodios" />
        <Stat label="Episódios sem agenda" value={data.counts.episodesPending} icon={ListChecks} to="/episodios" />
        <Stat label="Agendados no Buffer" value={(s.scheduled_buffer ?? 0) + (s.creating ?? 0)} icon={Send} tone="text-info" to="/publicacoes" />
        <Stat label="Publicados" value={s.published ?? 0} icon={CircleCheck} tone="text-success" to="/publicacoes" />
        <Stat label="Com erro ou atenção" value={(s.failed ?? 0) + (s.needs_attention ?? 0)} icon={CircleAlert} tone="text-danger" to="/publicacoes?aba=erros" />
        <Stat label="Manuais pendentes" value={data.counts.manualPending} icon={Hand} tone="text-warning" to="/publicacoes?aba=kwai" />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5 [&>*]:min-w-0">
        {[
          { label: 'Enviar vídeos', icon: Upload, to: '/biblioteca' },
          { label: 'Criar calendário', icon: CalendarPlus, to: '/calendario?gerar=1' },
          { label: 'Ver fila', icon: ListChecks, to: '/publicacoes' },
        ].map((a) => (
          <Button key={a.label} variant="outline" asChild className="justify-start">
            <Link to={a.to}>
              <a.icon />
              {a.label}
            </Link>
          </Button>
        ))}
        <Button variant="outline" className="justify-start" onClick={() => sync.mutate()} loading={sync.isPending}>
          <RefreshCw />
          Sincronizar
        </Button>
        <Button variant="outline" className="justify-start" onClick={() => retry.mutate()} loading={retry.isPending}>
          <RotateCcw />
          Reprocessar erros
        </Button>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Próximas publicações</CardTitle>
              <CardDescription>Horários em {tz.replace('_', ' ')}. Padrão diário: {data.defaultTimes.join(' e ')}.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/calendario">Calendário</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <EmptyState
                icon={CalendarPlus}
                title="Nada programado"
                description="Envie os vídeos e gere o calendário do mês."
                action={
                  <Button asChild size="sm">
                    <Link to="/calendario?gerar=1">Criar calendário</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {upcoming.map((g) => (
                  <li key={g.key} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{g.episodeTitle}</p>
                      <p className="text-xs text-muted tabular">
                        {formatDateTime(g.scheduledAt, tz, { weekday: 'short' })} · {formatRelative(g.scheduledAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {g.items.map((u) => (
                        <span key={u.id} title={`${u.platform}: ${u.state}`} className="relative">
                          <PlatformMark platform={u.platform} size="sm" />
                          <span className={cn('absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface', stateDot(u.state))} />
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-5 lg:col-span-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Redes e fila do Buffer</CardTitle>
                <CardDescription>Vagas ocupadas lidas no Buffer na última sincronização.</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/redes">Gerenciar</Link>
              </Button>
            </CardHeader>
            <CardContent className="grid gap-4">
              {data.channels.length === 0 && <p className="text-sm text-muted">Nenhuma rede conectada ainda.</p>}
              {data.channels.map((ch) => {
                const manual = ch.provider === 'manual';
                const used = ch.bufferScheduled ?? ch.appScheduled;
                const problem = ch.isDisconnected ? 'Desconectado' : ch.isLocked ? 'Bloqueado' : ch.isQueuePaused ? 'Fila pausada' : !ch.enabled ? 'Desativado' : null;
                return (
                  <div key={ch.id}>
                    <div className="flex items-center gap-2.5">
                      <PlatformMark platform={ch.platform} size="sm" />
                      <span className="flex-1 truncate text-sm">{PLATFORM_LABEL[ch.platform]}</span>
                      {manual ? (
                        <Badge tone="warning">Manual</Badge>
                      ) : problem ? (
                        <Badge tone="danger">{problem}</Badge>
                      ) : (
                        <span className="text-sm text-muted tabular">
                          {used}/{ch.queueLimit}
                        </span>
                      )}
                    </div>
                    {!manual && <Progress className="mt-2" value={(used / Math.max(1, ch.queueLimit)) * 100} tone={used >= ch.queueLimit ? 'warning' : 'accent'} />}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recursos</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-muted">
                  <HardDrive className="size-4" />
                  Armazenamento R2
                </span>
                <span className="tabular">
                  {formatBytes(data.storage.bytes)} · {data.storage.assets} vídeos
                </span>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">API do Buffer hoje</span>
                  <span className="tabular">
                    {data.buffer.requestsToday}/{data.buffer.dailyBudget}
                  </span>
                </div>
                <Progress className="mt-2" value={(data.buffer.requestsToday / Math.max(1, data.buffer.dailyBudget)) * 100} />
              </div>
              {data.buffer.rateLimit?.windows.map((w) => (
                <div key={w.name} className="flex items-center justify-between text-xs text-muted">
                  <span>Cota {w.name}</span>
                  <span className="tabular">{w.remaining} restantes</span>
                </div>
              ))}
              <div className="border-t border-border pt-3 text-xs text-muted">
                {data.lastRun ? (
                  <>
                    Última execução {formatRelative(data.lastRun.started_at)} ({data.lastRun.trigger === 'cron' ? 'automática' : 'manual'}): {describeRun(data.lastRun.summary)}
                  </>
                ) : (
                  'O agendador ainda não rodou.'
                )}
              </div>
              <Button variant="link" size="sm" asChild className="justify-start">
                <Link to="/uso">Ver uso e custos</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
