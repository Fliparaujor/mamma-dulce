import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { Notice, PageHeader } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress, Skeleton } from '@/components/ui/controls';
import { useToast } from '@/components/ui/toast';
import { api, post } from '@/lib/api';
import type { RateLimitSnapshot } from '@/lib/types';
import { formatBytes } from '@/lib/utils';

interface Usage {
  storage: { assets: number; bytes: number; gb: number; uploading: number; uploadedThisMonth: { count: number; bytes: number } };
  r2: {
    pricing: { storagePerGBMonth: number; classAPerMillion: number; classBPerMillion: number; free: { storageGB: number; classA: number; classB: number } };
    estimates: {
      storageGBMonth: number;
      classAThisMonth: number;
      classBLast30Days: number;
      egressBytesLast30Days: number;
      costUsd: { storage: number; classA: number; classB: number; total: number };
    };
  };
  buffer: {
    limits: { free: { per15min: number; perDay: number; per30DaysPerChannel: number; per30DaysMax: number; scheduledPerChannel: number; channels: number } };
    channels: number;
    requestsToday: number;
    requestsLast30Days: number;
    limit30Days: number;
    dailyBudget: number;
    lastRateLimit: RateLimitSnapshot | null;
    intervalMinutes: number;
  };
  workers: { freeRequestsPerDay: number; mediaRequestsLast30Days: number; cronInvocationsPerDay: number; notes: string[] };
  warnings: string[];
}

interface CleanupPreview {
  bytes: number;
  candidates?: { id: string; original_filename: string; size_bytes: number; reason: string }[];
  retentionDays: number;
  deleted: number;
}

function Meter({ label, used, limit, unit = '' }: { label: string; used: number; limit: number; unit?: string }) {
  const pct = (used / Math.max(1, limit)) * 100;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">{label}</span>
        <span className="tabular">
          {used.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
          {unit} / {limit.toLocaleString('pt-BR')}
          {unit}
        </span>
      </div>
      <Progress className="mt-2" value={pct} tone={pct > 90 ? 'danger' : pct > 70 ? 'warning' : 'accent'} />
    </div>
  );
}

const usd = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export default function UsagePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/api/usage') });
  const [preview, setPreview] = React.useState<CleanupPreview | null>(null);
  const check = useMutation({
    mutationFn: () => post<CleanupPreview>('/api/media/cleanup', { dryRun: true }),
    onSuccess: setPreview,
    onError: (e: Error) => toast.error('Falha ao verificar', e.message),
  });
  const run = useMutation({
    mutationFn: () => post<CleanupPreview>('/api/media/cleanup', { dryRun: false }),
    onSuccess: (r) => {
      setPreview(null);
      void qc.invalidateQueries();
      toast.success(`${r.deleted} vídeo(s) apagado(s)`, `${formatBytes(r.bytes)} liberados.`);
    },
    onError: (e: Error) => toast.error('Falha na limpeza', e.message),
  });

  if (isLoading || !data) return <Skeleton className="h-96" />;
  const b = data.buffer;
  const free = b.limits.free;

  return (
    <div className="animate-in">
      <PageHeader title="Uso e custos" description="Estimativas a partir do que o próprio app registra. A fatura oficial está sempre no painel da Cloudflare." />
      {data.warnings.map((w) => (
        <Notice key={w} tone="warning" className="mb-3">
          {w}
        </Notice>
      ))}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cloudflare R2</CardTitle>
            <CardDescription>
              {data.storage.assets} vídeos · {formatBytes(data.storage.bytes)}. Franquia gratuita mensal: {data.r2.pricing.free.storageGB} GB, 1 milhão de operações classe A e 10
              milhões classe B. Saída de dados (egress) não é cobrada.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Meter label="Armazenamento" used={Number(data.storage.gb.toFixed(2))} limit={data.r2.pricing.free.storageGB} unit=" GB" />
            <Meter label="Operações classe A (envios) no mês" used={data.r2.estimates.classAThisMonth} limit={data.r2.pricing.free.classA} />
            <Meter label="Operações classe B (leituras) em 30 dias" used={data.r2.estimates.classBLast30Days} limit={data.r2.pricing.free.classB} />
            <div className="rounded-lg bg-surface-2 p-3 text-sm">
              <p className="font-medium">Custo estimado acima da franquia: {usd(data.r2.estimates.costUsd.total)}/mês</p>
              <p className="mt-1 text-xs text-muted">
                Depois da franquia: {usd(data.r2.pricing.storagePerGBMonth)} por GB-mês, {usd(data.r2.pricing.classAPerMillion)} por milhão de classe A,{' '}
                {usd(data.r2.pricing.classBPerMillion)} por milhão de classe B. Valores em dólar, sem conversão.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API do Buffer (plano Free)</CardTitle>
            <CardDescription>
              Limites documentados: {free.per15min} por 15 min, {free.perDay} por dia e {free.per30DaysPerChannel.toLocaleString('pt-BR')} por canal a cada 30 dias (máx.{' '}
              {free.per30DaysMax.toLocaleString('pt-BR')}). Até {free.scheduledPerChannel} posts agendados por canal e {free.channels} canais.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Meter label="Hoje (teto do app)" used={b.requestsToday} limit={b.dailyBudget} />
            <Meter label="Últimos 30 dias" used={b.requestsLast30Days} limit={b.limit30Days} />
            {b.lastRateLimit && (
              <div className="text-xs text-muted">
                Último cabeçalho do Buffer: {b.lastRateLimit.windows.map((w) => `${w.name}: ${w.remaining} restantes`).join(' · ')}
              </div>
            )}
            <Notice>
              Estimativa: com intervalo de {b.intervalMinutes} min e sincronização inteligente, cada execução que consulta o Buffer gasta de 1 a 3 requisições, mais 1 por post
              criado. Com o cron a cada 15 min e sem sincronização inteligente, o consumo pode passar de 100 por dia e estourar o limite de 30 dias do plano Free.
            </Notice>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workers e D1</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              Plano gratuito do Workers: {data.workers.freeRequestsPerDay.toLocaleString('pt-BR')} requisições por dia. Entregas de vídeo nos últimos 30 dias:{' '}
              {data.workers.mediaRequestsLast30Days.toLocaleString('pt-BR')}.
            </p>
            <ul className="list-disc pl-5 text-muted">
              {data.workers.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <p className="text-muted">D1 gratuito: 5 GB, 5 milhões de linhas lidas e 100 mil escritas por dia. Este app usa uma fração mínima disso.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Limpeza de mídia antiga</CardTitle>
            <CardDescription>Só entram vídeos sem publicação pendente e fora do período de retenção. Vídeos com agenda futura nunca são apagados.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button variant="secondary" onClick={() => check.mutate()} loading={check.isPending}>
              Verificar o que pode ser apagado
            </Button>
            {preview && (
              <>
                <p className="text-sm">
                  {preview.candidates?.length ?? 0} vídeo(s), {formatBytes(preview.bytes)} (retenção de {preview.retentionDays} dias).
                </p>
                <ul className="max-h-48 overflow-y-auto text-xs text-muted">
                  {preview.candidates?.map((c) => (
                    <li key={c.id}>
                      {c.original_filename} · {formatBytes(c.size_bytes)} · {c.reason === 'unused' ? 'nunca usado' : 'já publicado'}
                    </li>
                  ))}
                </ul>
                <Button variant="danger" disabled={!preview.candidates?.length} loading={run.isPending} onClick={() => run.mutate()}>
                  <Trash2 />
                  Apagar agora
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
