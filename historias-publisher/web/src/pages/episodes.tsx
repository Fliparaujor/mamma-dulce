import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CAPTION_LIMITS, PLATFORM_LABEL, PLATFORMS, YOUTUBE_TITLE_LIMIT, type Platform } from '@shared/constants';
import { Clapperboard, Layers, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Notice, PageHeader, PlatformMark, StateBadge, stateDot } from '@/components/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Dialog, DialogContent, SheetContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAppSettings } from '@/hooks/use-settings';
import { api, del, patch, post } from '@/lib/api';
import type { Episode, PlatformConfig, Series } from '@/lib/types';
import { cn, formatDateTime, formatDuration } from '@/lib/utils';

function Counter({ value, limit }: { value: number; limit: number }) {
  return <span className={cn('text-xs tabular', value > limit ? 'text-danger' : 'text-muted')}>{value}/{limit}</span>;
}

interface Draft {
  title: string;
  description: string;
  seriesId: number;
  episodeNumber: number;
  captionMode: 'shared' | 'custom';
  sharedCaption: string;
  sharedHashtags: string;
  platforms: Record<Platform, PlatformConfig>;
}

function toDraft(e: Episode): Draft {
  return {
    title: e.title,
    description: e.description,
    seriesId: e.seriesId,
    episodeNumber: e.episodeNumber,
    captionMode: e.captionMode,
    sharedCaption: e.sharedCaption,
    sharedHashtags: e.sharedHashtags,
    platforms: structuredClone(e.platforms),
  };
}

function EpisodeEditor({ episodeId, series, onClose }: { episodeId: number | null; series: Series[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone } = useAppSettings();
  const { data } = useQuery({
    queryKey: ['episode', episodeId],
    queryFn: () => api<{ episode: Episode }>(`/api/episodes/${episodeId}`),
    enabled: episodeId !== null,
  });
  const [draft, setDraft] = React.useState<Draft | null>(null);
  React.useEffect(() => {
    if (data?.episode) setDraft(toDraft(data.episode));
  }, [data?.episode]);

  const save = useMutation({
    mutationFn: (d: Draft) => patch<{ episode: Episode; notice: string | null }>(`/api/episodes/${episodeId}`, d),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success('Episódio salvo', r.notice ?? undefined);
    },
    onError: (e: Error) => toast.error('Não foi possível salvar', e.message),
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/episodes/${episodeId}`),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Episódio excluído');
      onClose();
    },
    onError: (e: Error) => toast.error('Não foi possível excluir', e.message),
  });

  const ep = data?.episode;
  const setP = (p: Platform, patchP: Partial<PlatformConfig>) =>
    setDraft((d) => (d ? { ...d, platforms: { ...d.platforms, [p]: { ...d.platforms[p], ...patchP } } } : d));

  return (
    <Dialog open={episodeId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={ep ? ep.title : 'Episódio'} description={ep ? `${ep.seriesTitle} · Episódio ${ep.episodeNumber}` : undefined}>
        {!ep || !draft ? (
          <Skeleton className="h-64" />
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft);
            }}
          >
            {ep.media?.path ? (
              <video src={ep.media.path} controls playsInline preload="metadata" className="max-h-72 w-full rounded-lg bg-black object-contain" />
            ) : (
              <Notice tone="warning">
                Sem vídeo vinculado. <Link to="/biblioteca" className="underline">Envie na Biblioteca</Link>.
              </Notice>
            )}
            {ep.media && (
              <p className="-mt-3 text-xs text-muted">
                {ep.media.filename} · {formatDuration(ep.media.durationMs)}
                {ep.media.width && ep.media.height && ep.media.width > ep.media.height ? ' · horizontal (o YouTube não trata como Short)' : ''}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-[1fr_110px]">
              <Field label="Título">
                <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={200} />
              </Field>
              <Field label="Episódio">
                <Input type="number" min={1} value={draft.episodeNumber} onChange={(e) => setDraft({ ...draft, episodeNumber: Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Série">
              <Select value={draft.seriesId} onChange={(e) => setDraft({ ...draft, seriesId: Number(e.target.value) })}>
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Descrição geral" hint="Uso interno (sinopse, notas). Não é enviada às redes.">
              <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} />
            </Field>

            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Legenda personalizada por rede</p>
                  <p className="text-xs text-muted">Desligado: a mesma legenda e hashtags vão para todas as redes.</p>
                </div>
                <Switch checked={draft.captionMode === 'custom'} onCheckedChange={(c) => setDraft({ ...draft, captionMode: c ? 'custom' : 'shared' })} />
              </div>
            </div>

            <Field label="Legenda geral">
              <Textarea value={draft.sharedCaption} onChange={(e) => setDraft({ ...draft, sharedCaption: e.target.value })} rows={4} />
            </Field>
            <Field label="Hashtags gerais" hint={ep.seriesHashtags ? `A série acrescenta: ${ep.seriesHashtags}` : 'Separe por espaço ou vírgula; o # é opcional.'}>
              <Input value={draft.sharedHashtags} onChange={(e) => setDraft({ ...draft, sharedHashtags: e.target.value })} />
            </Field>

            <Tabs defaultValue="instagram">
              <TabsList className="w-full">
                {PLATFORMS.map((p) => (
                  <TabsTrigger key={p} value={p} className="flex-1">
                    <PlatformMark platform={p} size="sm" />
                  </TabsTrigger>
                ))}
              </TabsList>
              {PLATFORMS.map((p) => {
                const cfg = draft.platforms[p];
                const preview = ep.previews[p];
                return (
                  <TabsContent key={p} value={p} className="mt-4 flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Publicar no {PLATFORM_LABEL[p]}</span>
                      <Switch checked={cfg.enabled} onCheckedChange={(c) => setP(p, { enabled: c })} />
                    </div>
                    {p === 'youtube' && (
                      <Field label="Título no YouTube" hint={<Counter value={(cfg.title || draft.title).length} limit={YOUTUBE_TITLE_LIMIT} />}>
                        <Input value={cfg.title ?? ''} placeholder={draft.title} onChange={(e) => setP(p, { title: e.target.value || null })} maxLength={100} />
                      </Field>
                    )}
                    {draft.captionMode === 'custom' && (
                      <>
                        <Field label={`Legenda para ${PLATFORM_LABEL[p]}`} hint="Vazio: usa a legenda geral.">
                          <Textarea value={cfg.caption ?? ''} onChange={(e) => setP(p, { caption: e.target.value || null })} rows={4} />
                        </Field>
                        <Field label="Hashtags desta rede" hint="Vazio: usa as hashtags gerais e da série.">
                          <Input value={cfg.hashtags ?? ''} onChange={(e) => setP(p, { hashtags: e.target.value || null })} />
                        </Field>
                      </>
                    )}
                    <div className="rounded-lg bg-surface-2 p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs font-medium text-muted">Texto salvo que será enviado</span>
                        <Counter value={preview.length} limit={CAPTION_LIMITS[p]} />
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{preview || <span className="text-muted">(vazio)</span>}</p>
                    </div>
                  </TabsContent>
                );
              })}
            </Tabs>

            {ep.issues.length > 0 && (
              <Notice tone="warning">
                <ul className="list-disc pl-4">
                  {ep.issues.map((i, n) => (
                    <li key={n}>{i.message}</li>
                  ))}
                </ul>
              </Notice>
            )}

            {ep.jobs.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">Publicações</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {ep.jobs.map((j) => (
                    <li key={j.id} className="flex items-center gap-3 px-3 py-2">
                      <PlatformMark platform={j.platform} size="sm" />
                      <span className="flex-1 text-sm tabular">{formatDateTime(j.scheduledAt, timezone, { weekday: 'short' })}</span>
                      <StateBadge state={j.state} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="sticky bottom-0 -mx-5 flex items-center justify-between gap-2 border-t border-border bg-surface px-5 py-3">
              <Button
                type="button"
                variant="ghost"
                className="text-danger"
                onClick={() => window.confirm('Excluir este episódio? O vídeo continua na Biblioteca.') && remove.mutate()}
              >
                <Trash2 />
                Excluir
              </Button>
              <Button type="submit" loading={save.isPending}>
                Salvar
              </Button>
            </div>
          </form>
        )}
      </SheetContent>
    </Dialog>
  );
}

function BatchDialog({ ids, series, open, onOpenChange }: { ids: number[]; series: Series[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [seriesId, setSeriesId] = React.useState('');
  const [captionMode, setCaptionMode] = React.useState('');
  const [sharedCaption, setSharedCaption] = React.useState('');
  const [replaceCaption, setReplaceCaption] = React.useState(false);
  const [appendHashtags, setAppendHashtags] = React.useState('');
  const [platforms, setPlatforms] = React.useState<Partial<Record<Platform, boolean>>>({});

  const apply = useMutation({
    mutationFn: () =>
      post<{ updated: number }>('/api/episodes/batch', {
        ids,
        patch: {
          ...(seriesId ? { seriesId: Number(seriesId) } : {}),
          ...(captionMode ? { captionMode } : {}),
          ...(replaceCaption ? { sharedCaption } : {}),
          ...(appendHashtags.trim() ? { appendHashtags: appendHashtags.trim() } : {}),
          ...(Object.keys(platforms).length ? { platformsEnabled: platforms } : {}),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(`${r.updated} episódio(s) atualizado(s)`);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error('Edição em lote falhou', e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Editar ${ids.length} episódio(s)`} description="Só os campos preenchidos são alterados.">
        <div className="flex flex-col gap-4">
          <Field label="Mover para a série">
            <Select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
              <option value="">Não alterar</option>
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Modo de legenda">
            <Select value={captionMode} onChange={(e) => setCaptionMode(e.target.value)}>
              <option value="">Não alterar</option>
              <option value="shared">Mesma legenda em todas as redes</option>
              <option value="custom">Personalizada por rede</option>
            </Select>
          </Field>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={replaceCaption} onCheckedChange={(c) => setReplaceCaption(c === true)} />
              Substituir a legenda geral
            </label>
            {replaceCaption && <Textarea value={sharedCaption} onChange={(e) => setSharedCaption(e.target.value)} rows={3} />}
          </div>
          <Field label="Acrescentar hashtags">
            <Input value={appendHashtags} onChange={(e) => setAppendHashtags(e.target.value)} placeholder="#historias #lendas" />
          </Field>
          <div>
            <p className="mb-2 text-[13px] font-medium">Redes</p>
            <div className="grid grid-cols-2 gap-2">
              {PLATFORMS.map((p) => (
                <Select
                  key={p}
                  value={platforms[p] === undefined ? '' : platforms[p] ? 'on' : 'off'}
                  onChange={(e) =>
                    setPlatforms((cur) => {
                      const next = { ...cur };
                      if (e.target.value === '') delete next[p];
                      else next[p] = e.target.value === 'on';
                      return next;
                    })
                  }
                >
                  <option value="">{PLATFORM_LABEL[p]}: manter</option>
                  <option value="on">{PLATFORM_LABEL[p]}: ligar</option>
                  <option value="off">{PLATFORM_LABEL[p]}: desligar</option>
                </Select>
              ))}
            </div>
          </div>
          <Button onClick={() => apply.mutate()} loading={apply.isPending}>
            Aplicar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewSeriesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = React.useState('');
  const [hashtags, setHashtags] = React.useState('');
  const create = useMutation({
    mutationFn: () => post('/api/series', { title, defaultHashtags: hashtags }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['series'] });
      toast.success('Série criada');
      setTitle('');
      setHashtags('');
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error('Não foi possível criar', e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Nova série">
        <div className="flex flex-col gap-4">
          <Field label="Nome">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Hashtags da série" hint="Acrescentadas a todos os episódios da série.">
            <Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
          </Field>
          <Button disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Criar série
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function EpisodesPage() {
  const { timezone } = useAppSettings();
  const [seriesFilter, setSeriesFilter] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [editing, setEditing] = React.useState<number | null>(null);
  const [batchOpen, setBatchOpen] = React.useState(false);
  const [newSeries, setNewSeries] = React.useState(false);

  const series = useQuery({ queryKey: ['series'], queryFn: () => api<{ series: Series[] }>('/api/series') });
  const episodes = useQuery({ queryKey: ['episodes'], queryFn: () => api<{ episodes: Episode[] }>('/api/episodes') });

  const list = (episodes.data?.episodes ?? []).filter(
    (e) =>
      (!seriesFilter || String(e.seriesId) === seriesFilter) &&
      (!search || `${e.title} ${e.seriesTitle} ${e.episodeNumber}`.toLowerCase().includes(search.toLowerCase())),
  );
  const allSelected = list.length > 0 && list.every((e) => selected.has(e.id));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="animate-in">
      <PageHeader
        title="Episódios"
        description="Cada episódio é um vídeo com legenda, hashtags e redes. As publicações (uma por rede) são criadas pelo calendário."
        actions={
          <>
            <Button variant="secondary" onClick={() => setNewSeries(true)}>
              <Plus />
              Nova série
            </Button>
            <Button variant="secondary" disabled={selected.size === 0} onClick={() => setBatchOpen(true)}>
              <Layers />
              Editar em lote{selected.size ? ` (${selected.size})` : ''}
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Buscar episódio" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select className="sm:w-64" value={seriesFilter} onChange={(e) => setSeriesFilter(e.target.value)}>
          <option value="">Todas as séries</option>
          {series.data?.series.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} ({s.episode_count})
            </option>
          ))}
        </Select>
      </div>

      {episodes.isLoading ? (
        <Skeleton className="h-96" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title="Nenhum episódio"
          description="Envie os vídeos na Biblioteca e transforme-os em episódios."
          action={
            <Button asChild size="sm">
              <Link to="/biblioteca">Ir para a Biblioteca</Link>
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2.5 text-xs text-muted">
            <Checkbox checked={allSelected} onCheckedChange={(c) => setSelected(c ? new Set(list.map((e) => e.id)) : new Set())} aria-label="Selecionar todos" />
            <span>{list.length} episódio(s)</span>
          </div>
          <ul className="divide-y divide-border">
            {list.map((e) => {
              const byPlatform = new Map(e.jobs.map((j) => [j.platform, j]));
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/40">
                  <Checkbox checked={selected.has(e.id)} onCheckedChange={() => toggle(e.id)} aria-label={`Selecionar ${e.title}`} />
                  <span className="w-8 text-center font-display text-2xl leading-none text-muted tabular">{e.episodeNumber}</span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(e.id)}>
                    <p className="truncate text-sm font-medium">{e.title}</p>
                    <p className="truncate text-xs text-muted">
                      {e.seriesTitle}
                      {!e.media && ' · sem vídeo'}
                      {e.issues.length > 0 && ` · ${e.issues.length} pendência(s)`}
                    </p>
                  </button>
                  <div className="hidden items-center gap-1.5 sm:flex">
                    {PLATFORMS.map((p) => {
                      const j = byPlatform.get(p);
                      const enabled = e.platforms[p].enabled;
                      return (
                        <span key={p} className={cn('relative', !enabled && 'opacity-25')} title={j ? `${PLATFORM_LABEL[p]}: ${formatDateTime(j.scheduledAt, timezone)}` : PLATFORM_LABEL[p]}>
                          <PlatformMark platform={p} size="sm" />
                          {j && <span className={cn('absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface', stateDot(j.state))} />}
                        </span>
                      );
                    })}
                  </div>
                  {e.jobs[0] ? (
                    <span className="hidden w-28 text-right text-xs text-muted tabular md:block">{formatDateTime(e.jobs[0].scheduledAt, timezone)}</span>
                  ) : (
                    <Badge className="hidden md:inline-flex">Sem agenda</Badge>
                  )}
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(e.id)} aria-label="Editar">
                    <Pencil />
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <EpisodeEditor episodeId={editing} series={series.data?.series ?? []} onClose={() => setEditing(null)} />
      <BatchDialog ids={[...selected]} series={series.data?.series ?? []} open={batchOpen} onOpenChange={setBatchOpen} />
      <NewSeriesDialog open={newSeries} onOpenChange={setNewSeries} />
    </div>
  );
}
