import { useMutation, useQueryClient } from '@tanstack/react-query';
import { zonedToUtc } from '@shared/time';
import { CalendarClock } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { post } from '@/lib/api';

/** O que vai no arrasto de um episódio no calendário. */
export interface DraggedEpisode {
  episodeId: number;
  title: string;
  scheduledAt: string;
  time: string;
}

export const DRAG_TYPE = 'application/x-historias-episode';

export function MoveEpisodeDialog({
  drop,
  timezone,
  onClose,
}: {
  drop: { episode: DraggedEpisode; date: string } | null;
  timezone: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [time, setTime] = React.useState('');
  const [closeGap, setCloseGap] = React.useState(true);

  React.useEffect(() => {
    if (drop) setTime(drop.episode.time);
  }, [drop]);

  const earlier = !!drop && !!time && zonedToUtc(drop.date, time, timezone).toISOString() < drop.episode.scheduledAt;

  const move = useMutation({
    mutationFn: async () => {
      const { episode, date } = drop!;
      if (earlier && closeGap) {
        const r = await post<{ moved: number; failed?: string }>(`/api/episodes/${episode.episodeId}/pull`, { date, time, apply: true });
        if (r.failed) throw new Error(`Parou depois de ${r.moved} publicações. ${r.failed}`);
        return;
      }
      const r = await post<{ results: { ok: boolean; error?: string }[] }>(`/api/episodes/${episode.episodeId}/reschedule`, { date, time });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) throw new Error(failed.map((x) => x.error).join(' '));
    },
    onSuccess: () => {
      toast.success('Episódio movido');
      onClose();
    },
    onError: (e: Error) => toast.error('Não foi possível mover', e.message),
    onSettled: () => void qc.invalidateQueries(),
  });

  const dateLabel = drop ? `${drop.date.slice(8)}/${drop.date.slice(5, 7)}` : '';

  return (
    <Dialog open={!!drop} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Mover para ${dateLabel}`} description={drop?.episode.title}>
        <div className="flex flex-col gap-4">
          <Field label="Hora">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          {earlier && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={closeGap} onCheckedChange={(v) => setCloseGap(v === true)} className="mt-0.5" />
              <span>
                Subir os episódios seguintes uma vaga cada
                <span className="block text-xs text-muted">Assim não fica buraco no lugar de onde este saiu.</span>
              </span>
            </label>
          )}
          <p className="text-xs text-muted">Vale para todas as redes do episódio, inclusive as que já estão no Buffer.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => move.mutate()} loading={move.isPending} disabled={!time}>
              <CalendarClock />
              Mover
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
