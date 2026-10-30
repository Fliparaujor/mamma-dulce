import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABEL, PLATFORMS, type Platform } from '@shared/constants';
import { addDays, localDate, localTime, weekday, zonedToUtc } from '@shared/time';
import { CalendarPlus, ChevronLeft, ChevronRight, MoveRight, Plus, X } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { JobSheet } from '@/components/job-sheet';
import { DRAG_TYPE, MoveEpisodeDialog, type DraggedEpisode } from '@/components/move-episode';
import { Notice, PageHeader, PlatformMark, stateDot } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Checkbox, Tabs, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAppSettings } from '@/hooks/use-settings';
import { api, post } from '@/lib/api';
import type { CalendarPlan, Job } from '@/lib/types';
import { capitalizeFirst, cn } from '@/lib/utils';

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

interface Slot {
  key: string;
  time: string;
  episodeTitle: string;
  episodeNumber: number;
  seriesTitle: string;
  jobs: Job[];
}

function groupByDay(jobs: Job[], tz: string): Map<string, Slot[]> {
  const days = new Map<string, Map<string, Slot>>();
  for (const j of jobs) {
    const d = localDate(j.scheduledAt, tz);
    const time = localTime(j.scheduledAt, tz);
    const key = `${j.episodeId}@${j.scheduledAt}`;
    const slots = days.get(d) ?? new Map<string, Slot>();
    const slot = slots.get(key) ?? { key, time, episodeTitle: j.episodeTitle, episodeNumber: j.episodeNumber, seriesTitle: j.seriesTitle, jobs: [] };
    slot.jobs.push(j);
    slots.set(key, slot);
    days.set(d, slots);
  }
  const out = new Map<string, Slot[]>();
  for (const [d, slots] of days) out.set(d, [...slots.values()].sort((a, b) => a.time.localeCompare(b.time)));
  return out;
}

const UNMOVABLE: Job['state'][] = ['published', 'creating', 'cancelled'];

function SlotItem({ slot, onOpen, compact }: { slot: Slot; onOpen: (id: number) => void; compact?: boolean }) {
  const movable = slot.jobs.some((j) => !UNMOVABLE.includes(j.state));
  return (
    <div
      draggable={movable}
      onDragStart={(e) => {
        const j = slot.jobs[0]!;
        const data: DraggedEpisode = { episodeId: j.episodeId, title: slot.episodeTitle, scheduledAt: j.scheduledAt, time: slot.time };
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(data));
        e.dataTransfer.effectAllowed = 'move';
      }}
      title={movable ? 'Arraste para outro dia' : undefined}
      className={cn('rounded-md border border-border bg-surface-2/70', movable && 'cursor-grab active:cursor-grabbing', compact ? 'px-1.5 py-1' : 'px-2.5 py-2')}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] font-medium text-accent tabular">{slot.time}</span>
        <span className={cn('truncate', compact ? 'text-[11px]' : 'text-sm font-medium')}>
          {compact ? `Ep. ${slot.episodeNumber}` : slot.episodeTitle}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {slot.jobs
          .sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform))
          .map((j) => (
            <button
              key={j.id}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(j.id);
              }}
              className="relative"
              title={`${PLATFORM_LABEL[j.platform]}: abrir`}
            >
              <PlatformMark platform={j.platform} size="sm" className={cn(compact && 'h-4 w-5 text-[8px]')} />
              <span className={cn('absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-surface', stateDot(j.state))} />
            </button>
          ))}
      </div>
    </div>
  );
}

function GeneratorDialog({ open, onOpenChange, tz, defaults }: { open: boolean; onOpenChange: (o: boolean) => void; tz: string; defaults: { times: string[]; days: number } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [startDate, setStartDate] = React.useState(() => localDate(new Date(Date.now() + 24 * 3600_000), tz));
  const [days, setDays] = React.useState(defaults.days);
  const [times, setTimes] = React.useState<string[]>(defaults.times);
  const [platforms, setPlatforms] = React.useState<Platform[]>([...PLATFORMS]);
  const [plan, setPlan] = React.useState<CalendarPlan | null>(null);

  React.useEffect(() => {
    if (open) {
      setTimes(defaults.times);
      setDays(defaults.days);
      setPlan(null);
    }
  }, [open, defaults.times, defaults.days]);

  const body = { startDate, days, times: times.filter(Boolean), platforms };
  const preview = useMutation({
    mutationFn: () => post<{ plan: CalendarPlan }>('/api/calendar/preview', body),
    onSuccess: (r) => setPlan(r.plan),
    onError: (e: Error) => toast.error('Não foi possível montar o calendário', e.message),
  });
  const commit = useMutation({
    mutationFn: () => post<{ created: number; plan: CalendarPlan }>('/api/calendar/commit', body),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(`${r.created} publicação(ões) planejada(s)`, 'O envio ao Buffer acontece aos poucos, respeitando as 10 vagas por canal.');
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error('Falha ao criar o calendário', e.message),
  });

  const totalJobs = plan?.items.reduce((a, i) => a + i.platforms.length, 0) ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Gerar calendário" description="Distribui os episódios ainda não programados, na ordem da história, um por horário." wide>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Primeiro dia">
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Dias">
                <Input type="number" min={1} max={120} value={days} onChange={(e) => setDays(Number(e.target.value))} />
              </Field>
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium">Horários por dia ({tz.replace('_', ' ')})</p>
              <div className="flex flex-col gap-2">
                {times.map((t, i) => (
                  <div key={i} className="flex gap-2">
                    <Input type="time" value={t} onChange={(e) => setTimes((l) => l.map((x, n) => (n === i ? e.target.value : x)))} />
                    <Button variant="ghost" size="icon" disabled={times.length === 1} onClick={() => setTimes((l) => l.filter((_, n) => n !== i))} aria-label="Remover horário">
                      <X />
                    </Button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="self-start" onClick={() => setTimes((l) => [...l, '21:00'])} disabled={times.length >= 12}>
                  <Plus />
                  Horário
                </Button>
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium">Redes</p>
              <div className="grid grid-cols-2 gap-2">
                {PLATFORMS.map((p) => (
                  <label key={p} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    <Checkbox
                      checked={platforms.includes(p)}
                      onCheckedChange={(c) => setPlatforms((l) => (c ? [...l, p] : l.filter((x) => x !== p)))}
                    />
                    <PlatformMark platform={p} size="sm" />
                    {PLATFORM_LABEL[p].split(' ')[0]}
                  </label>
                ))}
              </div>
            </div>
            <Button variant="secondary" onClick={() => preview.mutate()} loading={preview.isPending} disabled={platforms.length === 0}>
              Pré-visualizar
            </Button>
          </div>

          <div className="flex min-h-64 flex-col rounded-xl border border-border bg-surface-2/40 p-3">
            {!plan ? (
              <p className="m-auto max-w-56 text-center text-sm text-muted">A pré-visualização mostra a distribuição antes de gravar qualquer coisa.</p>
            ) : (
              <>
                <div className="mb-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="font-display text-3xl">{plan.items.length}</p>
                    <p className="text-xs text-muted">episódios</p>
                  </div>
                  <div>
                    <p className="font-display text-3xl">{totalJobs}</p>
                    <p className="text-xs text-muted">publicações</p>
                  </div>
                  <div>
                    <p className="font-display text-3xl">{plan.freeSlotsLeft}</p>
                    <p className="text-xs text-muted">horários livres</p>
                  </div>
                </div>
                {plan.pastSlots + plan.occupiedSlots > 0 && (
                  <p className="mb-2 text-xs text-muted">
                    {plan.pastSlots} horário(s) já passaram e {plan.occupiedSlots} estão ocupados; foram pulados.
                  </p>
                )}
                {plan.skipped.length > 0 && (
                  <Notice tone="warning" className="mb-2 text-xs">
                    {plan.skipped.length} episódio(s) não entram: {plan.skipped[0]!.reason}
                  </Notice>
                )}
                <ul className="max-h-64 flex-1 divide-y divide-border overflow-y-auto text-sm">
                  {plan.items.map((i) => (
                    <li key={`${i.episodeId}-${i.slot.scheduledAt}`} className="flex items-center gap-2 py-1.5">
                      <span className="w-24 shrink-0 text-xs text-muted tabular">
                        {i.slot.date ? `${i.slot.date.slice(8)}/${i.slot.date.slice(5, 7)} ${i.slot.time}` : localTime(i.slot.scheduledAt, tz)}
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
                <Button className="mt-3" onClick={() => commit.mutate()} loading={commit.isPending} disabled={plan.items.length === 0}>
                  <CalendarPlus />
                  Confirmar {totalJobs} publicações
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShiftDialog({ open, onOpenChange, tz }: { open: boolean; onOpenChange: (o: boolean) => void; tz: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [fromDate, setFromDate] = React.useState(() => localDate(new Date(Date.now() + 24 * 3600_000), tz));
  const [days, setDays] = React.useState(1);
  const shift = useMutation({
    mutationFn: () => post<{ moved: number; skippedInBuffer: number }>('/api/jobs/shift', { fromDate, days }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(
        `${r.moved} publicação(ões) deslocada(s)`,
        r.skippedInBuffer ? `${r.skippedInBuffer} já estão no Buffer e não foram movidas; reagende-as individualmente.` : undefined,
      );
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error('Não foi possível deslocar', e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Deslocar sequência" description="Empurra todas as publicações a partir de uma data, mantendo a ordem da história.">
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="A partir de">
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </Field>
            <Field label="Dias (negativo antecipa)">
              <Input type="number" value={days} min={-60} max={60} onChange={(e) => setDays(Number(e.target.value))} />
            </Field>
          </div>
          <Notice>Publicações já agendadas no Buffer não são movidas por aqui, para não gastar cota da API.</Notice>
          <Button onClick={() => shift.mutate()} loading={shift.isPending} disabled={!days}>
            <MoveRight />
            Deslocar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function CalendarPage() {
  const { timezone: tz, data: settingsData } = useAppSettings();
  const [params, setParams] = useSearchParams();
  const [view, setView] = React.useState<'month' | 'week'>(() => (window.innerWidth < 640 ? 'week' : 'month'));
  const today = localDate(new Date(), tz);
  const [anchor, setAnchor] = React.useState(today);
  const [jobId, setJobId] = React.useState<number | null>(null);
  const [dayOpen, setDayOpen] = React.useState<string | null>(null);
  const [shiftOpen, setShiftOpen] = React.useState(false);
  const [dragOver, setDragOver] = React.useState<string | null>(null);
  const [drop, setDrop] = React.useState<{ episode: DraggedEpisode; date: string } | null>(null);
  const dropTarget = (d: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOver !== d) setDragOver(d);
    },
    onDragLeave: () => setDragOver((cur) => (cur === d ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (raw) setDrop({ episode: JSON.parse(raw) as DraggedEpisode, date: d });
    },
  });
  const generatorOpen = params.get('gerar') === '1';

  const range = React.useMemo(() => {
    if (view === 'week') {
      const start = addDays(anchor, -weekday(anchor));
      return { start, days: 7 };
    }
    const first = `${anchor.slice(0, 7)}-01`;
    const start = addDays(first, -weekday(first));
    return { start, days: 42 };
  }, [anchor, view]);

  const from = zonedToUtc(range.start, '00:00', tz).toISOString();
  const to = zonedToUtc(addDays(range.start, range.days), '00:00', tz).toISOString();
  const { data } = useQuery({
    queryKey: ['jobs', 'calendar', from, to],
    queryFn: () => api<{ jobs: Job[] }>(`/api/jobs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=1000`),
  });
  const byDay = React.useMemo(() => groupByDay(data?.jobs ?? [], tz), [data, tz]);
  const days = Array.from({ length: range.days }, (_, i) => addDays(range.start, i));
  const monthLabel = capitalizeFirst(new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${anchor.slice(0, 7)}-15T12:00:00Z`)));

  const move = (dir: number) => setAnchor((a) => (view === 'week' ? addDays(a, dir * 7) : addDays(`${a.slice(0, 7)}-15`, dir * 30)));

  return (
    <div className="animate-in">
      <PageHeader
        title="Calendário"
        description="Tudo que está planejado, agendado e publicado. Arraste um episódio para outro dia, ou toque numa rede para ver detalhes."
        actions={
          <>
            <Button variant="secondary" onClick={() => setShiftOpen(true)}>
              <MoveRight />
              Deslocar
            </Button>
            <Button onClick={() => setParams({ gerar: '1' })}>
              <CalendarPlus />
              Gerar calendário
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => move(-1)} aria-label="Anterior">
            <ChevronLeft />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => move(1)} aria-label="Próximo">
            <ChevronRight />
          </Button>
          <h2 className="ml-2 font-display text-2xl">{monthLabel}</h2>
          <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
            Hoje
          </Button>
        </div>
        <Tabs value={view} onValueChange={(v) => setView(v as 'month' | 'week')}>
          <TabsList>
            <TabsTrigger value="month">Mês</TabsTrigger>
            <TabsTrigger value="week">Semana</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {view === 'month' ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-7 border-b border-border bg-surface-2/60 text-center text-[11px] tracking-wide text-muted uppercase">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-2">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((d) => {
              const slots = byDay.get(d) ?? [];
              const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
              return (
                <button
                  key={d}
                  onClick={() => setDayOpen(d)}
                  {...dropTarget(d)}
                  className={cn(
                    'flex min-h-20 flex-col gap-1 border-r border-b border-border p-1 text-left align-top transition-colors hover:bg-surface-2/50 sm:min-h-32 sm:p-1.5 [&:nth-child(7n)]:border-r-0',
                    !inMonth && 'bg-surface-2/30 opacity-50',
                    dragOver === d && 'bg-accent-soft ring-2 ring-accent ring-inset',
                  )}
                >
                  <span className={cn('text-xs tabular', d === today ? 'flex size-6 items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground' : 'text-muted')}>
                    {Number(d.slice(8))}
                  </span>
                  <div className="hidden flex-col gap-1 sm:flex">
                    {slots.slice(0, 3).map((s) => (
                      <SlotItem key={s.key} slot={s} onOpen={setJobId} compact />
                    ))}
                    {slots.length > 3 && <span className="text-[11px] text-muted">+{slots.length - 3}</span>}
                  </div>
                  <div className="flex flex-wrap gap-0.5 sm:hidden">
                    {slots.map((s) => (
                      <span key={s.key} className={cn('size-1.5 rounded-full', stateDot(s.jobs[0]!.state))} />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-7">
          {days.map((d) => {
            const slots = byDay.get(d) ?? [];
            return (
              <div
                key={d}
                {...dropTarget(d)}
                className={cn('rounded-xl border border-border bg-surface p-2', d === today && 'border-accent/60', dragOver === d && 'bg-accent-soft ring-2 ring-accent')}
              >
                <p className="mb-2 px-1 text-xs text-muted">
                  {WEEKDAYS[weekday(d)]} <span className={cn('tabular', d === today && 'font-semibold text-accent')}>{d.slice(8)}/{d.slice(5, 7)}</span>
                </p>
                <div className="flex flex-col gap-1.5">
                  {slots.length === 0 && <p className="px-1 pb-1 text-xs text-muted/70">Livre</p>}
                  {slots.map((s) => (
                    <SlotItem key={s.key} slot={s} onOpen={setJobId} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {[
          ['planned', 'Planejado'],
          ['scheduled_buffer', 'No Buffer'],
          ['published', 'Publicado'],
          ['manual_pending', 'Manual'],
          ['failed', 'Erro'],
        ].map(([s, l]) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', stateDot(s as Job['state']))} />
            {l}
          </span>
        ))}
      </div>

      <Dialog open={dayOpen !== null} onOpenChange={(o) => !o && setDayOpen(null)}>
        <DialogContent
          title={dayOpen ? capitalizeFirst(new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${dayOpen}T12:00:00Z`))) : ''}
        >
          <div className="flex flex-col gap-2">
            {(dayOpen ? byDay.get(dayOpen) ?? [] : []).map((s) => (
              <SlotItem key={s.key} slot={s} onOpen={(id) => setJobId(id)} />
            ))}
            {dayOpen && !(byDay.get(dayOpen)?.length) && <p className="text-sm text-muted">Nenhuma publicação neste dia.</p>}
          </div>
        </DialogContent>
      </Dialog>

      <GeneratorDialog
        open={generatorOpen}
        onOpenChange={(o) => (o ? setParams({ gerar: '1' }) : setParams({}))}
        tz={tz}
        defaults={{ times: settingsData?.settings.defaultTimes ?? ['12:00', '19:00'], days: settingsData?.settings.calendarDays ?? 30 }}
      />
      <ShiftDialog open={shiftOpen} onOpenChange={setShiftOpen} tz={tz} />
      <JobSheet jobId={jobId} timezone={tz} onClose={() => setJobId(null)} />
      <MoveEpisodeDialog drop={drop} timezone={tz} onClose={() => setDrop(null)} />
    </div>
  );
}
