import { JOB_STATE_LABEL, PLATFORM_LABEL, type JobState, type Platform } from '@shared/constants';
import { Ban, CircleAlert, CircleCheck, CircleDashed, Clock, Hand, LoaderCircle, Send } from 'lucide-react';
import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const PLATFORM_STYLE: Record<Platform, { short: string; color: string }> = {
  instagram: { short: 'IG', color: '#e1306c' },
  tiktok: { short: 'TT', color: '#14b8b0' },
  youtube: { short: 'YT', color: '#ff2a2a' },
  kwai: { short: 'KW', color: '#ff7a00' },
};

export function PlatformMark({ platform, size = 'md', className }: { platform: Platform; size?: 'sm' | 'md'; className?: string }) {
  const s = PLATFORM_STYLE[platform];
  return (
    <span
      title={PLATFORM_LABEL[platform]}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white',
        size === 'sm' ? 'h-5 w-6 text-[9px]' : 'h-7 w-8 text-[11px]',
        className,
      )}
      style={{ background: s.color }}
    >
      {s.short}
    </span>
  );
}

export function PlatformLabel({ platform }: { platform: Platform }) {
  return (
    <span className="inline-flex items-center gap-2">
      <PlatformMark platform={platform} size="sm" />
      <span className="text-sm">{PLATFORM_LABEL[platform]}</span>
    </span>
  );
}

const STATE_STYLE: Record<JobState, { tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; icon: React.ComponentType<{ className?: string }> }> = {
  planned: { tone: 'neutral', icon: CircleDashed },
  creating: { tone: 'info', icon: LoaderCircle },
  scheduled_buffer: { tone: 'info', icon: Send },
  manual_pending: { tone: 'warning', icon: Hand },
  published: { tone: 'success', icon: CircleCheck },
  failed: { tone: 'danger', icon: CircleAlert },
  needs_attention: { tone: 'warning', icon: Clock },
  cancelled: { tone: 'neutral', icon: Ban },
};

export function StateBadge({ state, className }: { state: JobState; className?: string }) {
  const s = STATE_STYLE[state];
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} className={className}>
      <Icon className={cn(state === 'creating' && 'animate-spin')} />
      {JOB_STATE_LABEL[state]}
    </Badge>
  );
}

export function stateDot(state: JobState): string {
  return {
    planned: 'bg-muted',
    creating: 'bg-info',
    scheduled_buffer: 'bg-info',
    manual_pending: 'bg-warning',
    published: 'bg-success',
    failed: 'bg-danger',
    needs_attention: 'bg-warning',
    cancelled: 'bg-border-strong',
  }[state];
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-[34px] leading-none sm:text-[40px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: React.ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border-strong px-6 py-14 text-center">
      <div className="mb-3 rounded-full bg-surface-2 p-3">
        <Icon className="size-5 text-muted" />
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', children, className }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: React.ReactNode; className?: string }) {
  const styles = {
    info: 'border-info/30 bg-info/8 text-foreground',
    warning: 'border-warning/35 bg-warning/10 text-foreground',
    danger: 'border-danger/35 bg-danger/10 text-foreground',
    success: 'border-success/35 bg-success/10 text-foreground',
  }[tone];
  return <div className={cn('rounded-lg border px-3.5 py-2.5 text-sm', styles, className)}>{children}</div>;
}
