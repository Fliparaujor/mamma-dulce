import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseEpisodeFilename, sortImportCandidates } from '@shared/filename';
import { CircleAlert, CircleCheck, CloudUpload, Copy, FileVideo, LoaderCircle, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Notice, PageHeader } from '@/components/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress, Skeleton } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, del, post } from '@/lib/api';
import type { MediaAsset } from '@/lib/types';
import { errorMessage, fingerprint, localValidation, normalizedType, performUpload, readVideoMeta, type UploadPlan } from '@/lib/upload';
import { cn, formatBytes, formatDuration } from '@/lib/utils';

interface MediaResponse {
  uploadMode: 'direct' | 'worker';
  maxUploadBytes: number;
  assets: MediaAsset[];
}

type ItemStatus = 'queued' | 'preparing' | 'uploading' | 'done' | 'error' | 'duplicate' | 'cancelled';
interface UploadItem {
  key: string;
  file: File;
  status: ItemStatus;
  progress: number;
  error?: string;
  duplicates?: { id: string; original_filename: string }[];
  allowDuplicate?: boolean;
  controller?: AbortController;
}

const CONCURRENCY = 2;

function useUploadQueue(maxBytes: number, onFinished: () => void) {
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const running = React.useRef(new Set<string>());
  const itemsRef = React.useRef(items);
  itemsRef.current = items;

  const update = React.useCallback((key: string, patch: Partial<UploadItem>) => {
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

  const runOne = React.useCallback(
    async (item: UploadItem) => {
      running.current.add(item.key);
      const controller = new AbortController();
      update(item.key, { status: 'preparing', controller, error: undefined });
      try {
        const [fp, meta] = await Promise.all([fingerprint(item.file), readVideoMeta(item.file)]);
        let init: { assetId: string; plan: UploadPlan };
        try {
          init = await post('/api/uploads', {
            filename: item.file.name,
            contentType: normalizedType(item.file),
            size: item.file.size,
            fingerprint: fp,
            ...meta,
            allowDuplicate: item.allowDuplicate ?? false,
          });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            const body = e.body as { duplicates?: { id: string; original_filename: string }[] };
            update(item.key, { status: 'duplicate', duplicates: body.duplicates ?? [] });
            return;
          }
          throw e;
        }
        update(item.key, { status: 'uploading', progress: 0 });
        await performUpload(item.file, init.assetId, init.plan, {
          signal: controller.signal,
          onProgress: (f) => update(item.key, { progress: Math.min(0.99, f) }),
        });
        update(item.key, { status: 'done', progress: 1 });
      } catch (e) {
        if ((e as Error).name === 'AbortError') update(item.key, { status: 'cancelled' });
        else update(item.key, { status: 'error', error: errorMessage(e) });
      } finally {
        running.current.delete(item.key);
      }
    },
    [update],
  );

  // Despacha os itens da fila respeitando a concorrência.
  React.useEffect(() => {
    const queued = items.filter((i) => i.status === 'queued' && !running.current.has(i.key));
    const free = CONCURRENCY - running.current.size;
    for (const item of queued.slice(0, Math.max(0, free))) void runOne(item);
    const active = items.some((i) => ['queued', 'preparing', 'uploading'].includes(i.status));
    if (!active && items.some((i) => i.status === 'done')) onFinished();
  }, [items, runOne, onFinished]);

  const add = (files: FileList | File[]) => {
    const list = [...files];
    setItems((prev) => [
      ...prev,
      ...list.map((file) => {
        const err = localValidation(file, maxBytes);
        return {
          key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
          file,
          status: (err ? 'error' : 'queued') as ItemStatus,
          progress: 0,
          error: err ?? undefined,
        };
      }),
    ]);
  };
  const cancel = (key: string) => {
    const it = itemsRef.current.find((i) => i.key === key);
    it?.controller?.abort();
    if (it?.status === 'queued') update(key, { status: 'cancelled' });
  };
  const forceDuplicate = (key: string) => update(key, { status: 'queued', allowDuplicate: true });
  const retry = (key: string) => update(key, { status: 'queued', progress: 0, error: undefined });
  const clearFinished = () => setItems((l) => l.filter((i) => !['done', 'cancelled'].includes(i.status)));
  return { items, add, cancel, forceDuplicate, retry, clearFinished };
}

function StatusIcon({ status }: { status: ItemStatus }) {
  if (status === 'done') return <CircleCheck className="size-4 text-success" />;
  if (status === 'error') return <CircleAlert className="size-4 text-danger" />;
  if (status === 'duplicate') return <Copy className="size-4 text-warning" />;
  if (status === 'cancelled') return <X className="size-4 text-muted" />;
  return <LoaderCircle className="size-4 animate-spin text-muted" />;
}

const STATUS_TEXT: Record<ItemStatus, string> = {
  queued: 'Na fila',
  preparing: 'Analisando…',
  uploading: 'Enviando',
  done: 'Concluído',
  error: 'Erro',
  duplicate: 'Possível duplicado',
  cancelled: 'Cancelado',
};

interface ImportRow {
  assetId: string;
  filename: string;
  seriesName: string;
  episodeNumber: string;
  include: boolean;
  confidence: 'high' | 'low' | 'none';
}

function ImportPanel({ assets }: { assets: MediaAsset[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const orphans = assets.filter((a) => a.status === 'ready' && !a.episode);
  const [rows, setRows] = React.useState<ImportRow[]>([]);

  React.useEffect(() => {
    setRows((prev) => {
      const known = new Map(prev.map((r) => [r.assetId, r]));
      const sorted = sortImportCandidates(orphans.map((a) => ({ filename: a.filename, parsed: parseEpisodeFilename(a.filename), asset: a })));
      return sorted.map(({ asset, parsed }) => {
        const existing = known.get(asset.id);
        if (existing) return existing;
        return {
          assetId: asset.id,
          filename: asset.filename,
          seriesName: parsed.seriesName ?? '',
          episodeNumber: parsed.episodeNumber ? String(parsed.episodeNumber) : '',
          include: parsed.confidence !== 'none',
          confidence: parsed.confidence,
        };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphans.map((a) => a.id).join(',')]);

  const importMutation = useMutation({
    mutationFn: (items: { assetId: string; seriesName: string; episodeNumber: number }[]) =>
      post<{ created: number; attached: number; skipped: { reason: string }[] }>('/api/episodes/import', { items }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(`${r.created} episódio(s) criado(s)`, r.skipped.length ? `${r.skipped.length} ignorado(s): ${r.skipped[0]!.reason}` : undefined);
    },
    onError: (e: Error) => toast.error('Falha ao importar', e.message),
  });

  if (orphans.length === 0) return null;
  const selected = rows.filter((r) => r.include);
  const invalid = selected.filter((r) => !r.seriesName.trim() || !(Number(r.episodeNumber) > 0));
  const set = (id: string, patch: Partial<ImportRow>) => setRows((l) => l.map((r) => (r.assetId === id ? { ...r, ...patch } : r)));

  return (
    <Card className="mb-6 border-accent/40">
      <CardHeader>
        <CardTitle>Transformar vídeos em episódios</CardTitle>
        <CardDescription>
          {orphans.length} vídeo(s) sem episódio. A série e o número foram detectados pelo nome do arquivo; confira antes de criar.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="w-10 px-3 py-2" />
                <th className="px-3 py-2">Arquivo</th>
                <th className="px-3 py-2">Série</th>
                <th className="w-24 px-3 py-2">Ep.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.assetId} className={cn(!r.include && 'opacity-50')}>
                  <td className="px-3 py-1.5">
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={r.include} onChange={(e) => set(r.assetId, { include: e.target.checked })} />
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-1.5 text-muted" title={r.filename}>
                    {r.filename}
                    {r.confidence === 'low' && <Badge tone="warning" className="ml-2">conferir</Badge>}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input className="h-8" value={r.seriesName} onChange={(e) => set(r.assetId, { seriesName: e.target.value })} />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input className="h-8 tabular" inputMode="numeric" value={r.episodeNumber} onChange={(e) => set(r.assetId, { episodeNumber: e.target.value.replace(/\D/g, '') })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">{invalid.length > 0 ? `${invalid.length} linha(s) sem série ou número.` : `${selected.length} selecionado(s).`}</p>
          <Button
            disabled={selected.length === 0 || invalid.length > 0}
            loading={importMutation.isPending}
            onClick={() =>
              importMutation.mutate(selected.map((r) => ({ assetId: r.assetId, seriesName: r.seriesName.trim(), episodeNumber: Number(r.episodeNumber) })))
            }
          >
            Criar {selected.length} episódio(s)
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function LibraryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['media'], queryFn: () => api<MediaResponse>('/api/media') });
  const onFinished = React.useCallback(() => void qc.invalidateQueries({ queryKey: ['media'] }), [qc]);
  const queue = useUploadQueue(data?.maxUploadBytes ?? 500 * 1024 * 1024, onFinished);
  const [dragging, setDragging] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<MediaAsset | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/media/${id}`),
    onSuccess: () => {
      setToDelete(null);
      void qc.invalidateQueries();
      toast.success('Vídeo excluído');
    },
    onError: (e: Error) => toast.error('Não foi possível excluir', e.message),
  });

  const total = queue.items.length;
  const finished = queue.items.filter((i) => i.status === 'done').length;

  return (
    <div className="animate-in">
      <PageHeader
        title="Biblioteca"
        description="Envie os episódios uma única vez. Os vídeos ficam no Cloudflare R2 e são entregues ao Buffer por um link fixo do próprio app."
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) queue.add(e.dataTransfer.files);
        }}
        className={cn(
          'mb-6 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface',
        )}
      >
        <CloudUpload className="mb-3 size-8 text-accent" />
        <p className="font-medium">Arraste os vídeos aqui</p>
        <p className="mt-1 text-sm text-muted">
          MP4 ou MOV, até {formatBytes(data?.maxUploadBytes ?? 0)} cada. Nomes como <code>Historia_01_Ep01.mp4</code> são reconhecidos.
        </p>
        <Button className="mt-5" onClick={() => inputRef.current?.click()}>
          Escolher arquivos
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) queue.add(e.target.files);
            e.target.value = '';
          }}
        />
        {data && (
          <p className="mt-4 text-xs text-muted">
            {data.uploadMode === 'direct' ? 'Envio direto ao R2 por URL temporária.' : 'Envio pelo Worker (credenciais S3 do R2 não configuradas).'}
          </p>
        )}
      </div>

      {total > 0 && (
        <Card className="mb-6">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Envios</CardTitle>
              <CardDescription>
                {finished} de {total} concluído(s). Mantenha esta aba aberta até terminar.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={queue.clearFinished}>
              Limpar concluídos
            </Button>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {queue.items.map((it) => {
                const parsed = parseEpisodeFilename(it.file.name);
                return (
                  <li key={it.key} className="py-3">
                    <div className="flex items-center gap-3">
                      <StatusIcon status={it.status} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{it.file.name}</p>
                        <p className="text-xs text-muted">
                          {formatBytes(it.file.size)} · {STATUS_TEXT[it.status]}
                          {it.status === 'uploading' && ` ${Math.round(it.progress * 100)}%`}
                          {parsed.episodeNumber && ` · ${parsed.seriesName ?? 'Série'} ep. ${parsed.episodeNumber}`}
                        </p>
                      </div>
                      {['queued', 'preparing', 'uploading'].includes(it.status) && (
                        <Button size="icon-sm" variant="ghost" onClick={() => queue.cancel(it.key)} aria-label="Cancelar envio">
                          <X />
                        </Button>
                      )}
                      {it.status === 'error' && !localValidation(it.file, data?.maxUploadBytes ?? Infinity) && (
                        <Button size="sm" variant="secondary" onClick={() => queue.retry(it.key)}>
                          Tentar de novo
                        </Button>
                      )}
                      {it.status === 'duplicate' && (
                        <Button size="sm" variant="secondary" onClick={() => queue.forceDuplicate(it.key)}>
                          Enviar mesmo assim
                        </Button>
                      )}
                    </div>
                    {it.status === 'uploading' && <Progress className="mt-2" value={it.progress * 100} />}
                    {it.error && <p className="mt-1.5 text-xs text-danger">{it.error}</p>}
                    {it.status === 'duplicate' && (
                      <p className="mt-1.5 text-xs text-warning">Parece igual a: {it.duplicates?.map((d) => d.original_filename).join(', ')}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {data && <ImportPanel assets={data.assets} />}

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Vídeos armazenados</h2>
        {data && <span className="text-sm text-muted">{data.assets.filter((a) => a.status === 'ready').length} vídeo(s)</span>}
      </div>
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-[9/14]" />
          ))}
        </div>
      ) : !data || data.assets.length === 0 ? (
        <EmptyState icon={FileVideo} title="Nenhum vídeo ainda" description="Envie os episódios do mês para começar." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.assets.map((a) => (
            <div key={a.id} className="group overflow-hidden rounded-xl border border-border bg-surface">
              <div className="relative aspect-[9/14] bg-black">
                {a.path ? (
                  <video src={`${a.path}#t=0.5`} preload="metadata" controls playsInline className="size-full object-contain" />
                ) : (
                  <div className="flex size-full items-center justify-center text-xs text-muted">Envio incompleto</div>
                )}
              </div>
              <div className="p-3">
                <p className="truncate text-sm font-medium" title={a.filename}>
                  {a.filename}
                </p>
                <p className="mt-0.5 text-xs text-muted tabular">
                  {formatBytes(a.sizeBytes)} · {formatDuration(a.durationMs)}
                  {a.width && a.height ? ` · ${a.width}×${a.height}` : ''}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  {a.episode ? (
                    <Link to="/episodios" className="truncate text-xs text-accent hover:underline">
                      {a.episode.title}
                    </Link>
                  ) : (
                    <Badge tone={a.status === 'ready' ? 'warning' : 'neutral'}>{a.status === 'ready' ? 'Sem episódio' : 'Incompleto'}</Badge>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setToDelete(a)}
                    disabled={a.activeJobs > 0}
                    title={a.activeJobs > 0 ? 'Há publicações pendentes usando este vídeo' : 'Excluir'}
                    aria-label="Excluir vídeo"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent title="Excluir vídeo?" description={toDelete?.filename}>
          <Notice tone="warning">
            O arquivo será apagado do R2. Publicações já concluídas continuam nas redes, mas o link do vídeo deixará de funcionar.
          </Notice>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              Cancelar
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => toDelete && remove.mutate(toDelete.id)}>
              Excluir
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
