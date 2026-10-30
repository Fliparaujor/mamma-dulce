import { useMutation, useQueryClient } from '@tanstack/react-query';
import { localDate, localTime } from '@shared/time';
import { ArrowUpToLine } from 'lucide-react';
import * as React from 'react';
import { Notice } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { post } from '@/lib/api';

interface PullMove {
  jobId: number;
  label: string;
  platform: string;
  from: string;
  to: string;
}

interface PullResult {
  moves: PullMove[];
  moved?: number;
  failed?: string;
}

/** Sugestão inicial: daqui a 1 hora, arredondado para os próximos 5 minutos. */
function suggestedStart(): Date {
  const step = 5 * 60_000;
  return new Date(Math.ceil((Date.now() + 3600_000) / step) * step);
}

export function PullEpisode({ episodeId, timezone, onDone }: { episodeId: number; timezone: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = React.useState(() => localDate(suggestedStart(), timezone));
  const [time, setTime] = React.useState(() => localTime(suggestedStart(), timezone));
  const [moves, setMoves] = React.useState<PullMove[] | null>(null);

  const preview = useMutation({
    mutationFn: () => post<PullResult>(`/api/episodes/${episodeId}/pull`, { date, time }),
    onSuccess: (r) => setMoves(r.moves),
    onError: (e: Error) => toast.error('Não dá para puxar', e.message),
  });

  const apply = useMutation({
    mutationFn: () => post<PullResult>(`/api/episodes/${episodeId}/pull`, { date, time, apply: true }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (r.failed) {
        toast.error(`Parou em ${r.moved} de ${r.moves.length} publicações`, r.failed);
      } else {
        toast.success('Calendário reorganizado', `${r.moved} publicações movidas.`);
      }
      onDone();
    },
    onError: (e: Error) => toast.error('Não foi possível reorganizar', e.message),
  });

  // Uma linha por horário: as redes de um episódio andam juntas.
  const rows = [...new Map((moves ?? []).map((m) => [`${m.label}|${m.to}`, m])).values()];
  const label = (iso: string) => `${localDate(iso, timezone).slice(8)}/${localDate(iso, timezone).slice(5, 7)} ${localTime(iso, timezone)}`;

  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-1 text-sm font-medium">Puxar e reorganizar</p>
      <p className="mb-3 text-xs text-muted">Antecipa este episódio em todas as redes. Os seguintes sobem uma vaga cada, para não ficar buraco.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data">
          <Input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setMoves(null);
            }}
          />
        </Field>
        <Field label="Hora">
          <Input
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              setMoves(null);
            }}
          />
        </Field>
      </div>
      {moves === null ? (
        <Button className="mt-3 w-full" variant="secondary" loading={preview.isPending} onClick={() => preview.mutate()}>
          <ArrowUpToLine />
          Ver como fica
        </Button>
      ) : (
        <>
          <ul className="mt-3 max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
            {rows.map((m) => (
              <li key={`${m.label}|${m.to}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="min-w-0 truncate">{m.label}</span>
                <span className="shrink-0 text-muted tabular">
                  {label(m.from)} → {label(m.to)}
                </span>
              </li>
            ))}
          </ul>
          <Notice className="mt-3" tone="warning">
            Isso altera {moves.length} publicações, inclusive as que já estão no Buffer.
          </Notice>
          <Button className="mt-3 w-full" loading={apply.isPending} onClick={() => apply.mutate()}>
            Confirmar reorganização
          </Button>
        </>
      )}
    </div>
  );
}
