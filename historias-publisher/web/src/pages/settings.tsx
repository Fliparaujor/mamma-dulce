import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { YOUTUBE_CATEGORIES } from '@shared/constants';
import { Pause, Play, Plus, X } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { Notice, PageHeader } from '@/components/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton, Switch } from '@/components/ui/controls';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAppSettings } from '@/hooks/use-settings';
import { api, patch, post } from '@/lib/api';
import type { SchedulerRun, Settings } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';
import { describeRun } from './dashboard';

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const TIMEZONES = ['America/Belem', 'America/Sao_Paulo', 'America/Fortaleza', 'America/Recife', 'America/Manaus', 'America/Cuiaba', 'America/Porto_Velho', 'America/Rio_Branco', 'America/Noronha'];

export default function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, timezone } = useAppSettings();
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api<{ runs: SchedulerRun[] }>('/api/scheduler/runs') });
  const [form, setForm] = React.useState<Settings | null>(null);
  React.useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  const save = useMutation({
    mutationFn: (s: Partial<Settings>) => patch<{ settings: Settings }>('/api/settings', s),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Configurações salvas');
    },
    onError: (e: Error) => toast.error('Não foi possível salvar', e.message),
  });
  const rotate = useMutation({
    mutationFn: () => post('/api/settings/ics-token/rotate'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Novo endereço da agenda gerado', 'O endereço antigo parou de funcionar.');
    },
  });

  if (isLoading || !form || !data) return <Skeleton className="h-96" />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const { bufferOrganizationId: _org, ...editable } = form;
  void _org;

  return (
    <div className="animate-in">
      <PageHeader
        title="Configurações"
        description="Horários, automação, padrões das redes e retenção de mídia."
        actions={
          <>
            <Button variant="secondary" onClick={() => save.mutate({ autofillPaused: !form.autofillPaused })}>
              {form.autofillPaused ? <Play /> : <Pause />}
              {form.autofillPaused ? 'Retomar abastecimento' : 'Pausar abastecimento'}
            </Button>
            <Button onClick={() => save.mutate(editable)} loading={save.isPending}>
              Salvar
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Calendário</CardTitle>
            <CardDescription>Valores iniciais do gerador. Os instantes são gravados em UTC e mostrados neste fuso.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Fuso horário">
              <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {TIMEZONES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace('_', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <p className="mb-1.5 text-[13px] font-medium">Horários padrão ({form.defaultTimes.length} por dia)</p>
              <div className="flex flex-wrap gap-2">
                {form.defaultTimes.map((t, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <Input type="time" className="w-28" value={t} onChange={(e) => set('defaultTimes', form.defaultTimes.map((x, n) => (n === i ? e.target.value : x)))} />
                    {form.defaultTimes.length > 1 && (
                      <Button size="icon-sm" variant="ghost" onClick={() => set('defaultTimes', form.defaultTimes.filter((_, n) => n !== i))} aria-label="Remover">
                        <X />
                      </Button>
                    )}
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={() => set('defaultTimes', [...form.defaultTimes, '21:00'])}>
                  <Plus />
                  Horário
                </Button>
              </div>
            </div>
            <Field label="Dias por calendário">
              <Input type="number" min={1} max={120} value={form.calendarDays} onChange={(e) => set('calendarDays', Number(e.target.value))} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Automação do Buffer</CardTitle>
            <CardDescription>O cron dispara a cada 15 minutos; o agendador só consulta o Buffer quando o intervalo abaixo vence.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Toggle
              label="Modo simulação (dry-run)"
              hint="Valida e registra o que seria enviado, sem criar posts no Buffer."
              checked={form.dryRun}
              onChange={(v) => set('dryRun', v)}
            />
            <Toggle label="Pausar abastecimento" hint="A reconciliação continua; nada novo é enviado." checked={form.autofillPaused} onChange={(v) => set('autofillPaused', v)} />
            <Toggle label="Sincronização inteligente" hint="Só consulta o Buffer quando algo pode ter mudado." checked={form.smartSync} onChange={(v) => set('smartSync', v)} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Intervalo (min)">
                <Input type="number" min={15} value={form.schedulerIntervalMinutes} onChange={(e) => set('schedulerIntervalMinutes', Number(e.target.value))} />
              </Field>
              <Field label="Envios por execução">
                <Input type="number" min={1} max={20} value={form.maxCreatesPerRun} onChange={(e) => set('maxCreatesPerRun', Number(e.target.value))} />
              </Field>
              <Field label="Requisições por execução">
                <Input type="number" min={3} max={40} value={form.maxBufferRequestsPerRun} onChange={(e) => set('maxBufferRequestsPerRun', Number(e.target.value))} />
              </Field>
              <Field label="Teto diário de requisições">
                <Input type="number" min={10} value={form.dailyBufferBudget} onChange={(e) => set('dailyBufferBudget', Number(e.target.value))} />
              </Field>
              <Field label="Antecedência mínima (min)" hint="Abaixo disso o post é considerado atrasado.">
                <Input type="number" min={5} value={form.minLeadMinutes} onChange={(e) => set('minLeadMinutes', Number(e.target.value))} />
              </Field>
              <Field label="Tentativas máximas">
                <Input type="number" min={1} max={10} value={form.maxRetryAttempts} onChange={(e) => set('maxRetryAttempts', Number(e.target.value))} />
              </Field>
            </div>
            <Field label="Política para atrasados">
              <Select value={form.latePolicy} onChange={(e) => set('latePolicy', e.target.value as Settings['latePolicy'])}>
                <option value="hold">Segurar e pedir decisão (recomendado)</option>
                <option value="skip">Cancelar automaticamente</option>
              </Select>
            </Field>
            <Notice>Nenhuma das opções publica fora do horário. Um post atrasado nunca é enviado sozinho.</Notice>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Padrões por rede</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Toggle label="Instagram: Reel também no feed" checked={form.instagramShareToFeed} onChange={(v) => set('instagramShareToFeed', v)} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="YouTube: categoria">
                <Select value={form.youtubeCategoryId} onChange={(e) => set('youtubeCategoryId', e.target.value)}>
                  {Object.entries(YOUTUBE_CATEGORIES).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="YouTube: privacidade">
                <Select value={form.youtubePrivacy} onChange={(e) => set('youtubePrivacy', e.target.value as Settings['youtubePrivacy'])}>
                  <option value="public">Público</option>
                  <option value="unlisted">Não listado</option>
                  <option value="private">Privado</option>
                </Select>
              </Field>
            </div>
            <Toggle label="YouTube: conteúdo para crianças" checked={form.youtubeMadeForKids} onChange={(v) => set('youtubeMadeForKids', v)} />
            <Toggle label="YouTube: notificar inscritos" checked={form.youtubeNotifySubscribers} onChange={(v) => set('youtubeNotifySubscribers', v)} />
            <Field label="Capa do vídeo (ms)" hint="Instante usado como capa no Instagram e TikTok. Vazio: padrão da rede.">
              <Input
                type="number"
                min={0}
                value={form.thumbnailOffsetMs ?? ''}
                onChange={(e) => set('thumbnailOffsetMs', e.target.value === '' ? null : Number(e.target.value))}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Mídia e Kwai</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Toggle
              label="Limpeza automática de mídia antiga"
              hint="Uma vez por dia apaga vídeos sem publicação pendente e fora do período de retenção."
              checked={form.mediaAutoCleanup}
              onChange={(v) => set('mediaAutoCleanup', v)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Retenção (dias)">
                <Input type="number" min={1} max={365} value={form.mediaRetentionDays} onChange={(e) => set('mediaRetentionDays', Number(e.target.value))} />
              </Field>
              <Field label="Lembrete do Kwai (min antes)">
                <Input type="number" min={0} value={form.kwaiReminderMinutes} onChange={(e) => set('kwaiReminderMinutes', Number(e.target.value))} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" asChild>
                <Link to="/uso">Ver uso e custos</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => rotate.mutate()} loading={rotate.isPending}>
                Gerar novo endereço da agenda
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Ambiente</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge tone={data.environment.bufferConfigured ? 'success' : 'warning'}>Buffer {data.environment.bufferConfigured ? 'configurado' : 'sem chave'}</Badge>
            <Badge tone={data.environment.directUploadConfigured ? 'success' : 'neutral'}>
              Upload {data.environment.directUploadConfigured ? 'direto ao R2' : 'pelo Worker'}
            </Badge>
            <Badge tone={data.environment.publicBaseUrl ? 'success' : 'warning'}>{data.environment.publicBaseUrl ?? 'URL pública não definida'}</Badge>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Execuções do agendador</CardTitle>
            <CardDescription>Só aparecem execuções que chegaram a falar com o Buffer ou foram disparadas à mão.</CardDescription>
          </CardHeader>
          <CardContent>
            {runs.data?.runs.length ? (
              <ul className="divide-y divide-border text-sm">
                {runs.data.runs.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                    <span className="w-36 shrink-0 text-muted tabular">{formatDateTime(r.started_at, timezone)}</span>
                    <Badge tone={r.status === 'ok' ? 'success' : r.status === 'error' ? 'danger' : r.status === 'partial' ? 'warning' : 'neutral'}>{r.status}</Badge>
                    <span className="flex-1">{describeRun(r.summary)}</span>
                    <span className="text-xs text-muted">{r.api_calls} req.</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nenhuma execução registrada.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
