import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseEpisodeFilename } from '@shared/filename';
import { parseCaptionFile } from '@shared/legendas';
import { CalendarPlus, Sparkles } from 'lucide-react';
import * as React from 'react';
import { Notice, PlatformMark } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, post } from '@/lib/api';
import type { CalendarPlan, MediaAsset, SettingsResponse } from '@/lib/types';

interface AutoPreview {
  plan: CalendarPlan;
  timezone: string;
  withoutCaption: string[];
}

interface Props {
  assets: MediaAsset[];
  captionFile: { name: string; text: string } | null;
  uploading: boolean;
  onCaptionsUsed: () => void;
}

export function AutoSchedulePanel({ assets, captionFile, uploading, onCaptionsUsed }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/api/settings') });
  const [preview, setPreview] = React.useState<AutoPreview | null>(null);

  const orphans = assets
    .filter((a) => a.status === 'ready' && !a.episode)
    .map((a) => ({ asset: a, parsed: parseEpisodeFilename(a.filename) }))
    .filter((o) => o.parsed.seriesName && o.parsed.episodeNumber);
  const captions = React.useMemo(() => (captionFile ? parseCaptionFile(captionFile.text) : []), [captionFile]);
  const detected = orphans[0]?.parsed.seriesName ?? '';
  const [seriesName, setSeriesName] = React.useState('');
  const series = seriesName || detected;

  const prepare = useMutation({
    mutationFn: async () => {
      if (orphans.length > 0) {
        await post('/api/episodes/import', {
          items: orphans.map((o) => ({ assetId: o.asset.id, seriesName: o.parsed.seriesName!, episodeNumber: o.parsed.episodeNumber! })),
        });
      }
      if (captions.length > 0) await post('/api/episodes/captions', { seriesName: series, items: captions });
      return post<AutoPreview>('/api/calendar/auto/preview', {});
    },
    onSuccess: (r) => {
      void qc.invalidateQueries();
      onCaptionsUsed();
      setPreview(r);
    },
    onError: (e: Error) => toast.error('Não foi possível preparar a agenda', e.message),
  });

  const commit = useMutation({
    mutationFn: () => post<{ created: number }>('/api/calendar/auto/commit', {}),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      setPreview(null);
      toast.success(`${r.created} publicações agendadas`, 'O Buffer recebe os posts em até 1 hora. Para enviar agora, use Sincronizar no Dashboard.');
    },
    onError: (e: Error) => toast.error('Falha ao agendar', e.message),
  });

  if (assets.length === 0 && !captionFile) return null;
  const items = preview?.plan.items ?? [];
  const s = settings?.settings;

  return (
    <Card className="mb-6 border-accent/40">
      <CardHeader>
        <CardTitle>Agenda automática</CardTitle>
        <CardDescription>
          Cria os episódios, aplica as legendas e sugere as próximas datas depois do último post do calendário
          {s ? ` (${s.autoPerDay} por dia, a partir das ${s.autoFirstTime}, de ${s.autoIntervalHours} em ${s.autoIntervalHours} horas).` : '.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="text-sm text-muted">
          <li>{orphans.length} vídeo(s) para virar episódio.</li>
          <li>{captionFile ? `${captions.length} legenda(s) lida(s) de ${captionFile.name}.` : 'Nenhum arquivo de legendas. Solte um .txt acima, se tiver.'}</li>
        </ul>
        {captions.length > 0 && (
          <label className="text-[13px] font-medium">
            Série das legendas
            <Input className="mt-1.5" value={series} onChange={(e) => setSeriesName(e.target.value)} placeholder="Nome da série" />
          </label>
        )}
        <div>
          <Button onClick={() => prepare.mutate()} loading={prepare.isPending} disabled={uploading || (captions.length > 0 && !series.trim())}>
            <Sparkles />
            {uploading ? 'Aguardando os envios…' : 'Sugerir datas'}
          </Button>
        </div>
      </CardContent>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent title="Confirmar agenda" description={`${items.length} episódio(s), fuso ${preview?.timezone ?? ''}`} wide>
          <div className="flex flex-col gap-3">
            {s?.dryRun && <Notice tone="warning">Modo simulação ligado: nada será enviado ao Buffer.</Notice>}
            {s && s.youtubePrivacy !== 'public' && <Notice tone="warning">YouTube configurado como não público. Altere em Configurações se quiser publicar para todos.</Notice>}
            {(preview?.withoutCaption.length ?? 0) > 0 && <Notice tone="warning">Sem legenda: {preview!.withoutCaption.join(', ')}.</Notice>}
            {(preview?.plan.skipped.length ?? 0) > 0 && <Notice tone="warning">{preview!.plan.skipped.length} episódio(s) ficaram de fora: {preview!.plan.skipped[0]!.reason}</Notice>}
            {items.length === 0 ? (
              <p className="text-sm text-muted">Nenhum episódio com vídeo esperando agenda.</p>
            ) : (
              <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
                {items.map((i) => (
                  <li key={i.episodeId} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-24 shrink-0 text-xs text-muted tabular">
                      {i.slot.date.slice(8)}/{i.slot.date.slice(5, 7)} {i.slot.time}
                    </span>
                    <span className="flex-1 truncate">{i.label}</span>
                    <span className="flex gap-0.5">
                      {i.platforms.map((p) => (
                        <PlatformMark key={p} platform={p} size="sm" />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Agora não
              </Button>
              <Button onClick={() => commit.mutate()} loading={commit.isPending} disabled={items.length === 0}>
                <CalendarPlus />
                Confirmar agenda
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
