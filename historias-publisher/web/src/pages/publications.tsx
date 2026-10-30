import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { JOB_STATE_LABEL, JOB_STATES, PLATFORM_LABEL, PLATFORMS } from '@shared/constants';
import { Bell, CalendarClock, CircleCheck, Copy, Download, ExternalLink, Inbox, RefreshCw, Share2, Undo2 } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { EmptyState, Notice, PageHeader, PlatformMark, StateBadge } from '@/components/domain';
import { JobSheet } from '@/components/job-sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAppSettings } from '@/hooks/use-settings';
import { api, post } from '@/lib/api';
import type { Job, KwaiItem } from '@/lib/types';
import { copyText, formatDateTime } from '@/lib/utils';

function JobsTable({ jobs, tz, onOpen }: { jobs: Job[]; tz: string; onOpen: (id: number) => void }) {
  if (jobs.length === 0) return <EmptyState icon={Inbox} title="Nada por aqui" description="Nenhuma publicação com esses filtros." />;
  return (
    <Card className="overflow-hidden">
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface-2/60 text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Episódio</th>
              <th className="px-4 py-2.5 font-medium">Rede</th>
              <th className="px-4 py-2.5 font-medium">Planejado</th>
              <th className="px-4 py-2.5 font-medium">Real</th>
              <th className="px-4 py-2.5 font-medium">No sistema</th>
              <th className="px-4 py-2.5 font-medium">Buffer</th>
              <th className="px-4 py-2.5 font-medium">ID remoto</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {jobs.map((j) => (
              <tr key={j.id} className="cursor-pointer hover:bg-surface-2/40" onClick={() => onOpen(j.id)}>
                <td className="max-w-64 px-4 py-2.5">
                  <p className="truncate font-medium">{j.episodeTitle}</p>
                  {(j.lastError || j.attentionReason) && <p className="truncate text-xs text-danger">{j.lastError ?? j.attentionReason}</p>}
                </td>
                <td className="px-4 py-2.5">
                  <PlatformMark platform={j.platform} size="sm" />
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap tabular">{formatDateTime(j.scheduledAt, tz, { weekday: 'short' })}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted tabular">{j.publishedAt ? formatDateTime(j.publishedAt, tz) : '—'}</td>
                <td className="px-4 py-2.5">
                  <StateBadge state={j.state} />
                </td>
                <td className="px-4 py-2.5 text-muted">{j.bufferStatus ?? '—'}</td>
                <td className="max-w-28 truncate px-4 py-2.5 font-mono text-xs text-muted">{j.bufferPostId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-border md:hidden">
        {jobs.map((j) => (
          <li key={j.id}>
            <button className="flex w-full items-start gap-3 px-4 py-3 text-left" onClick={() => onOpen(j.id)}>
              <PlatformMark platform={j.platform} size="sm" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{j.episodeTitle}</p>
                <p className="text-xs text-muted tabular">{formatDateTime(j.scheduledAt, tz, { weekday: 'short' })}</p>
                {(j.lastError || j.attentionReason) && <p className="mt-1 line-clamp-2 text-xs text-danger">{j.lastError ?? j.attentionReason}</p>}
              </div>
              <StateBadge state={j.state} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function useKwaiReminders(items: KwaiItem[]) {
  const [enabled, setEnabled] = React.useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const notified = React.useRef(new Set<number>());
  React.useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const now = Date.now();
      for (const it of items) {
        const t = new Date(it.scheduledAt).getTime();
        if (!notified.current.has(it.jobId) && t - now <= 5 * 60_000 && t - now > -30 * 60_000 && it.state !== 'published') {
          notified.current.add(it.jobId);
          try {
            new Notification('Hora de publicar no Kwai', { body: `${it.seriesTitle} · Ep. ${it.episodeNumber} (${it.localTime})`, tag: `kwai-${it.jobId}` });
          } catch {
            // navegador sem suporte a notificações fora de service worker
          }
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [enabled, items]);
  const request = async () => {
    if (typeof Notification === 'undefined') return false;
    const p = await Notification.requestPermission();
    setEnabled(p === 'granted');
    return p === 'granted';
  };
  return { enabled, request, supported: typeof Notification !== 'undefined' };
}

function KwaiCard({ item, tz, onConfirm }: { item: KwaiItem; tz: string; onConfirm: (item: KwaiItem) => void }) {
  const toast = useToast();
  const [sharing, setSharing] = React.useState(false);
  const canShareFiles = typeof navigator !== 'undefined' && 'canShare' in navigator;

  async function share() {
    if (!item.mediaPath) return;
    setSharing(true);
    try {
      const blob = await (await fetch(item.mediaPath)).blob();
      const file = new File([blob], item.mediaFilename ?? `episodio-${item.episodeNumber}.mp4`, { type: blob.type || 'video/mp4' });
      if (navigator.canShare?.({ files: [file] })) {
        await copyText(item.caption);
        await navigator.share({ files: [file], text: item.caption });
        toast.info('Legenda copiada', 'Escolha o Kwai na lista e cole a legenda se ela não aparecer sozinha.');
      } else {
        toast.error('Este navegador não compartilha arquivos', 'Use "Baixar vídeo" e publique pela galeria.');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error('Não foi possível compartilhar', (e as Error).message);
    } finally {
      setSharing(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-4 sm:pt-5">
        <div className="flex items-start gap-3">
          <PlatformMark platform="kwai" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{item.title}</p>
            <p className="text-sm text-muted tabular">{formatDateTime(item.scheduledAt, tz, { weekday: 'long' })}</p>
          </div>
          <StateBadge state={item.state} />
        </div>
        <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-surface-2 p-3 text-sm whitespace-pre-wrap">{item.caption || <span className="text-muted">Sem legenda.</span>}</div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Button
            variant="secondary"
            onClick={async () => ((await copyText(item.caption)) ? toast.success('Legenda copiada') : toast.error('Não foi possível copiar'))}
          >
            <Copy />
            Copiar legenda
          </Button>
          {item.mediaPath ? (
            <Button variant="secondary" asChild>
              <a href={item.mediaPath} download={item.mediaFilename ?? undefined}>
                <Download />
                Baixar vídeo
              </a>
            </Button>
          ) : (
            <Button variant="secondary" disabled>
              Sem vídeo
            </Button>
          )}
          {canShareFiles && item.mediaPath && (
            <Button variant="secondary" onClick={() => void share()} loading={sharing}>
              <Share2 />
              Compartilhar
            </Button>
          )}
          <Button variant="secondary" asChild>
            <a href="https://www.kwai.com/" target="_blank" rel="noreferrer">
              <ExternalLink />
              Abrir Kwai
            </a>
          </Button>
          <Button className="col-span-2" onClick={() => onConfirm(item)}>
            <CircleCheck />
            Marcar como publicado
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function KwaiTab({ tz, calendarUrl }: { tz: string; calendarUrl?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['kwai'],
    queryFn: () => api<{ pending: KwaiItem[]; upcoming: KwaiItem[]; history: KwaiItem[] }>('/api/kwai/queue'),
    refetchInterval: 60_000,
  });
  const [confirming, setConfirming] = React.useState<KwaiItem | null>(null);
  const [note, setNote] = React.useState('');
  const reminders = useKwaiReminders([...(data?.pending ?? []), ...(data?.upcoming ?? [])]);

  const confirm = useMutation({
    mutationFn: (item: KwaiItem) => post(`/api/jobs/${item.jobId}/manual-confirm`, { note: note.trim() || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Confirmado como publicado no Kwai');
      setConfirming(null);
      setNote('');
    },
    onError: (e: Error) => toast.error('Não foi possível confirmar', e.message),
  });
  const undo = useMutation({
    mutationFn: (jobId: number) => post(`/api/jobs/${jobId}/manual-undo`),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Confirmação desfeita');
    },
    onError: (e: Error) => toast.error('Não foi possível desfazer', e.message),
  });

  if (isLoading || !data) return <Skeleton className="h-64" />;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-4">
        <Notice>
          Este app não publica no Kwai automaticamente (não há integração oficial confirmada para contas brasileiras). Aqui você recebe o vídeo e a legenda prontos e
          confirma depois de postar; nada é marcado como publicado sem essa confirmação.
        </Notice>
        <h3 className="text-sm font-semibold">Para publicar agora ({data.pending.length})</h3>
        {data.pending.length === 0 ? (
          <EmptyState icon={CircleCheck} title="Nada pendente" description="Os episódios do Kwai aparecem aqui no dia da publicação." />
        ) : (
          data.pending.map((it) => <KwaiCard key={it.jobId} item={it} tz={tz} onConfirm={setConfirming} />)
        )}
        {data.upcoming.length > 0 && (
          <>
            <h3 className="mt-2 text-sm font-semibold">Próximos dias</h3>
            <Card>
              <ul className="divide-y divide-border">
                {data.upcoming.map((it) => (
                  <li key={it.jobId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="truncate">{it.title}</span>
                    <span className="shrink-0 text-muted tabular">{formatDateTime(it.scheduledAt, tz, { weekday: 'short' })}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="size-4" />
              Lembretes
            </CardTitle>
            <CardDescription>Push próprio exigiria serviço extra; estas duas opções são gratuitas.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div>
              <p className="font-medium">1. Agenda do celular (recomendado)</p>
              <p className="mt-1 text-muted">
                No Google Agenda pelo computador: Outras agendas → Do URL → cole o endereço abaixo. Cada episódio vira um evento com alarme e a legenda na descrição.
              </p>
              {calendarUrl && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={async () => ((await copyText(calendarUrl)) ? toast.success('Endereço da agenda copiado', 'Ele é secreto: não compartilhe.') : undefined)}
                >
                  <CalendarClock />
                  Copiar endereço da agenda
                </Button>
              )}
            </div>
            <div className="border-t border-border pt-3">
              <p className="font-medium">2. Aviso no navegador</p>
              <p className="mt-1 text-muted">Funciona enquanto o painel estiver aberto neste aparelho.</p>
              {reminders.supported ? (
                reminders.enabled ? (
                  <Badge tone="success" className="mt-2">
                    Avisos ativos
                  </Badge>
                ) : (
                  <Button variant="secondary" size="sm" className="mt-2" onClick={() => void reminders.request()}>
                    Ativar avisos
                  </Button>
                )
              ) : (
                <p className="mt-1 text-xs text-muted">Este navegador não suporta.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Confirmações recentes</CardTitle>
          </CardHeader>
          <CardContent>
            {data.history.length === 0 ? (
              <p className="text-sm text-muted">Nenhuma ainda.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.history.slice(0, 15).map((h) => (
                  <li key={h.jobId} className="flex items-start justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate">{h.title}</p>
                      <p className="text-xs text-muted">
                        Confirmado {formatDateTime(h.confirmedAt, tz)}
                        {h.note ? ` · ${h.note}` : ''}
                      </p>
                    </div>
                    <Button size="icon-sm" variant="ghost" onClick={() => undo.mutate(h.jobId)} aria-label="Desfazer confirmação" title="Desfazer">
                      <Undo2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent title="Confirmar publicação no Kwai" description={confirming?.title}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">Confirme só depois de ver o vídeo publicado no seu perfil do Kwai.</p>
            <Field label="Observação (opcional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex.: publicado às 19h05" maxLength={500} />
            </Field>
            <Button onClick={() => confirming && confirm.mutate(confirming)} loading={confirm.isPending}>
              Sim, já está publicado
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function PublicationsPage() {
  const { timezone: tz, data: settings } = useAppSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('aba') ?? 'todas';
  const [platform, setPlatform] = React.useState('');
  const [state, setState] = React.useState('');
  const [jobId, setJobId] = React.useState<number | null>(null);

  const stateFilter = tab === 'erros' ? 'failed,needs_attention' : state;
  const query = new URLSearchParams({ limit: '500' });
  if (platform) query.set('platform', platform);
  if (stateFilter) query.set('state', stateFilter);
  const { data, isLoading } = useQuery({
    queryKey: ['jobs', 'list', query.toString()],
    queryFn: () => api<{ jobs: Job[] }>(`/api/jobs?${query.toString()}`),
    enabled: tab !== 'kwai',
  });

  const sync = useMutation({
    mutationFn: () => post<{ summary: { notes: string[] } }>('/api/scheduler/run', { syncOnly: true }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success('Estados sincronizados com o Buffer', r.summary.notes.join(' ') || undefined);
    },
    onError: (e: Error) => toast.error('Falha ao sincronizar', e.message),
  });

  return (
    <div className="animate-in">
      <PageHeader
        title="Publicações"
        description="Planejado no sistema, agendado no Buffer, publicado, falhou e ação manual aparecem separados. Agendado no Buffer ainda não é publicado."
        actions={
          <Button variant="secondary" onClick={() => sync.mutate()} loading={sync.isPending}>
            <RefreshCw />
            Sincronizar estados
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'todas' ? {} : { aba: v })}>
        <TabsList className="mb-4">
          <TabsTrigger value="todas">Todas</TabsTrigger>
          <TabsTrigger value="erros">Erros e atenção</TabsTrigger>
          <TabsTrigger value="kwai">Kwai (manual)</TabsTrigger>
        </TabsList>
        <TabsContent value="kwai">
          <KwaiTab tz={tz} calendarUrl={settings?.kwaiCalendarUrl} />
        </TabsContent>
        {['todas', 'erros'].map((t) => (
          <TabsContent key={t} value={t}>
            <div className="mb-4 flex flex-col gap-2 sm:flex-row">
              <Select className="sm:w-56" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">Todas as redes</option>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </Select>
              {t === 'todas' && (
                <Select className="sm:w-64" value={state} onChange={(e) => setState(e.target.value)}>
                  <option value="">Todos os estados (exceto cancelados)</option>
                  {JOB_STATES.map((s) => (
                    <option key={s} value={s}>
                      {JOB_STATE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {isLoading ? <Skeleton className="h-64" /> : <JobsTable jobs={data?.jobs ?? []} tz={tz} onOpen={setJobId} />}
          </TabsContent>
        ))}
      </Tabs>
      <JobSheet jobId={jobId} timezone={tz} onClose={() => setJobId(null)} />
    </div>
  );
}
