import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABEL, type Platform } from '@shared/constants';
import { CircleCheck, CircleDashed, PlugZap, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Notice, PageHeader, PlatformMark } from '@/components/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress, Skeleton, Switch } from '@/components/ui/controls';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useAppSettings } from '@/hooks/use-settings';
import { api, patch, post } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

interface ChannelRow {
  id: number;
  platform: Platform;
  provider: 'buffer' | 'manual';
  external_id: string | null;
  name: string;
  display_name: string | null;
  avatar_url: string | null;
  is_disconnected: number;
  is_locked: number;
  is_queue_paused: number;
  default_to_reminders: number | null;
  enabled: number;
  queue_limit: number;
  buffer_scheduled_count: number | null;
  last_synced_at: string | null;
}

interface Org {
  id: string;
  name: string;
  channelCount: number;
  limits: { channels: number; scheduledPosts: number } | null;
}

interface BufferChannel {
  id: string;
  name: string;
  displayName: string | null;
  service: string;
}

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      {done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted" />}
      <div className="text-sm">
        <p className={done ? 'text-muted line-through decoration-muted/40' : 'font-medium'}>{title}</p>
        {!done && children && <div className="mt-1 text-muted">{children}</div>}
      </div>
    </li>
  );
}

function ChannelCard({ ch, bufferChannels }: { ch: ChannelRow; bufferChannels: BufferChannel[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [limit, setLimit] = React.useState(String(ch.queue_limit));
  const update = useMutation({
    mutationFn: (body: { enabled?: boolean; queueLimit?: number }) => patch(`/api/channels/${ch.id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Canal atualizado');
    },
    onError: (e: Error) => toast.error('Falha ao salvar', e.message),
  });
  const remap = useMutation({
    mutationFn: (externalId: string) => post('/api/buffer/map-channel', { platform: ch.platform, externalId }),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Canal do Buffer trocado');
    },
    onError: (e: Error) => toast.error('Falha ao trocar', e.message),
  });

  const manual = ch.provider === 'manual';
  const alternatives = bufferChannels.filter((b) => b.service === ch.platform);
  const used = ch.buffer_scheduled_count ?? 0;
  const problems = [
    ch.is_disconnected && 'Desconectado no Buffer: reconecte a conta lá.',
    ch.is_locked && 'Bloqueado no Buffer (limite de canais do plano).',
    ch.is_queue_paused && 'Fila pausada no Buffer: posts não serão publicados.',
  ].filter(Boolean) as string[];

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3">
        <PlatformMark platform={ch.platform} />
        <div className="min-w-0 flex-1">
          <CardTitle>{PLATFORM_LABEL[ch.platform]}</CardTitle>
          <CardDescription className="truncate">{manual ? 'Publicação manual assistida' : `${ch.display_name ?? ch.name} · ID ${ch.external_id}`}</CardDescription>
        </div>
        <Switch checked={ch.enabled === 1} onCheckedChange={(c) => update.mutate({ enabled: c })} aria-label="Ativar canal" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {problems.map((p) => (
          <Notice key={p} tone="danger">
            {p}
          </Notice>
        ))}
        {manual ? (
          <p className="text-sm text-muted">
            Existe a Kuaishou Open Platform, com permissão de publicação de vídeos, mas não foi possível confirmar que ela atende contas do Kwai no Brasil. Por isso o fluxo é
            manual: o painel monta a fila do dia com vídeo e legenda e você confirma depois de postar. O módulo é separado para receber uma integração oficial se ela for
            confirmada.
          </p>
        ) : (
          <>
            {ch.default_to_reminders === 1 && (
              <Notice tone="warning">Este canal está configurado no Buffer para publicar por lembrete (notificação). Posts podem exigir ação manual no celular.</Notice>
            )}
            {ch.platform === 'tiktok' && (
              <p className="text-xs text-muted">
                No TikTok, o Buffer pode publicar automaticamente ou por notificação, conforme o tipo de conta e as permissões concedidas. O tipo real de cada post aparece no
                histórico depois do envio.
              </p>
            )}
            <div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Fila no Buffer</span>
                <span className="tabular">
                  {ch.buffer_scheduled_count ?? '—'}/{ch.queue_limit}
                </span>
              </div>
              <Progress className="mt-2" value={(used / Math.max(1, ch.queue_limit)) * 100} tone={used >= ch.queue_limit ? 'warning' : 'accent'} />
              <p className="mt-1.5 text-xs text-muted">{ch.last_synced_at ? `Lido no Buffer ${formatRelative(ch.last_synced_at)}` : 'Ainda não sincronizado.'}</p>
            </div>
            <div className="flex items-end gap-2">
              <Field label="Limite de posts agendados" hint="Plano Free do Buffer: 10 por canal." className="flex-1">
                <Input type="number" min={0} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} />
              </Field>
              <Button variant="secondary" onClick={() => update.mutate({ queueLimit: Number(limit) })} disabled={Number(limit) === ch.queue_limit}>
                Salvar
              </Button>
            </div>
            {alternatives.length > 1 && (
              <Field label="Canal do Buffer usado">
                <Select value={ch.external_id ?? ''} onChange={(e) => remap.mutate(e.target.value)}>
                  {alternatives.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName ?? a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function ChannelsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: settings } = useAppSettings();
  const { data, isLoading } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ bufferConfigured: boolean; organizationId: string | null; channels: ChannelRow[] }>('/api/channels'),
  });
  const [orgs, setOrgs] = React.useState<Org[] | null>(null);
  const [bufferChannels, setBufferChannels] = React.useState<BufferChannel[]>([]);

  const test = useMutation({
    mutationFn: () => post<{ organizations: Org[] }>('/api/buffer/test'),
    onSuccess: (r) => {
      setOrgs(r.organizations);
      toast.success('Conexão com o Buffer funcionando', `${r.organizations.length} organização(ões) encontrada(s).`);
    },
    onError: (e: Error) => toast.error('Falha na conexão', e.message),
  });
  const chooseOrg = useMutation({
    mutationFn: (organizationId: string) => post('/api/buffer/organization', { organizationId }),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Organização selecionada');
    },
    onError: (e: Error) => toast.error('Falha ao selecionar', e.message),
  });
  const syncChannels = useMutation({
    mutationFn: () => post<{ channels: BufferChannel[]; mapped: Record<string, string | null> }>('/api/buffer/sync-channels'),
    onSuccess: (r) => {
      setBufferChannels(r.channels);
      void qc.invalidateQueries();
      const missing = Object.entries(r.mapped)
        .filter(([, v]) => !v)
        .map(([k]) => PLATFORM_LABEL[k as Platform]);
      if (missing.length) toast.info('Canais sincronizados', `Não encontrados no Buffer: ${missing.join(', ')}.`);
      else toast.success('Instagram, TikTok e YouTube mapeados');
    },
    onError: (e: Error) => toast.error('Falha ao sincronizar canais', e.message),
  });

  const env = settings?.environment;
  const hasChannels = (data?.channels ?? []).some((c) => c.provider === 'buffer');

  return (
    <div className="animate-in">
      <PageHeader title="Redes conectadas" description="Instagram, TikTok e YouTube são publicados pela API oficial do Buffer. O Kwai segue fluxo manual." />

      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PlugZap className="size-4" />
              Buffer
            </CardTitle>
            <CardDescription>Checklist de configuração</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ol className="flex flex-col gap-3">
              <Step done={!!env?.bufferConfigured} title="Chave da API salva como segredo">
                Gere em publish.buffer.com → Settings → API e rode <code>npx wrangler secret put BUFFER_API_KEY</code>. A chave nunca passa pelo navegador.
              </Step>
              <Step done={!!data?.organizationId} title="Organização escolhida" />
              <Step done={hasChannels} title="Canais sincronizados" />
              <Step done={!!env?.publicBaseUrl} title="URL pública HTTPS do app">
                Defina a variável <code>PUBLIC_BASE_URL</code> com o endereço workers.dev para o Buffer baixar os vídeos.
              </Step>
            </ol>
            {env?.publicBaseUrl && <p className="text-xs break-all text-muted">Vídeos servidos em {env.publicBaseUrl}/media/…</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending} disabled={!data?.bufferConfigured}>
                Testar conexão
              </Button>
              <Button variant="secondary" onClick={() => syncChannels.mutate()} loading={syncChannels.isPending} disabled={!data?.organizationId}>
                <RefreshCw />
                Sincronizar canais
              </Button>
            </div>
            {orgs && (
              <Field label="Organização">
                <Select value={data?.organizationId ?? ''} onChange={(e) => e.target.value && chooseOrg.mutate(e.target.value)}>
                  <option value="">Escolha…</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.channelCount} canais)
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {orgs?.some((o) => o.limits) && (
              <p className="text-xs text-muted">
                Limites informados pelo Buffer:{' '}
                {orgs
                  .filter((o) => o.limits)
                  .map((o) => `${o.name}: ${o.limits!.channels} canais, ${o.limits!.scheduledPosts} posts agendados`)
                  .join('; ')}
                .
              </p>
            )}
            {settings?.settings.dryRun && <Badge tone="warning">Modo simulação ligado</Badge>}
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          {isLoading ? (
            <>
              <Skeleton className="h-56" />
              <Skeleton className="h-56" />
            </>
          ) : (
            data?.channels.map((ch) => <ChannelCard key={ch.id} ch={ch} bufferChannels={bufferChannels} />)
          )}
        </div>
      </div>
    </div>
  );
}
