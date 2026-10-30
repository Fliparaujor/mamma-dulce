import type { JobState, Platform } from '@shared/constants';
import type { CalendarPlan } from '@shared/calendar';

export type { JobState, Platform, CalendarPlan };

export interface Job {
  id: number;
  episodeId: number;
  platform: Platform;
  scheduledAt: string;
  state: JobState;
  bufferPostId: string | null;
  bufferStatus: string | null;
  bufferSchedulingType: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  lastError: string | null;
  attentionReason: string | null;
  attemptCount: number;
  manualConfirmedAt: string | null;
  dryRunCheckedAt: string | null;
  updatedAt: string;
  episodeTitle: string;
  episodeNumber: number;
  seriesTitle: string;
  seriesId: number;
  mediaPath: string | null;
}

export interface Attempt {
  id: number;
  kind: string;
  outcome: 'success' | 'error' | 'unknown' | 'dry_run' | 'info';
  message: string | null;
  details: string | null;
  created_at: string;
  scheduler_run_id: number | null;
}

export interface PlatformConfig {
  enabled: boolean;
  caption: string | null;
  hashtags: string | null;
  title: string | null;
}

export interface Episode {
  id: number;
  seriesId: number;
  seriesTitle: string;
  episodeNumber: number;
  title: string;
  description: string;
  captionMode: 'shared' | 'custom';
  sharedCaption: string;
  sharedHashtags: string;
  seriesHashtags: string;
  media: {
    id: string;
    status: string | null;
    filename: string | null;
    sizeBytes: number | null;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    path: string | null;
  } | null;
  platforms: Record<Platform, PlatformConfig>;
  previews: Record<Platform, string>;
  issues: { platform: Platform; message: string }[];
  jobs: { id: number; platform: Platform; state: JobState; scheduledAt: string; bufferPostId: string | null; lastError: string | null; attentionReason: string | null }[];
  updatedAt: string;
}

export interface Series {
  id: number;
  slug: string;
  title: string;
  description: string;
  default_hashtags: string;
  position: number;
  episode_count: number;
}

export interface MediaAsset {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  status: 'uploading' | 'ready';
  fingerprint: string | null;
  createdAt: string;
  uploadedAt: string | null;
  path: string | null;
  episode: { id: number; title: string; seriesTitle: string } | null;
  activeJobs: number;
}

export interface RateLimitSnapshot {
  capturedAt: string;
  windows: { name: string; remaining: number; resetSeconds: number; quota: number | null; windowSeconds: number | null }[];
}

export interface ChannelSummary {
  id: number;
  platform: Platform;
  provider: 'buffer' | 'manual';
  name: string;
  avatarUrl: string | null;
  enabled: boolean;
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
  defaultToReminders: boolean | null;
  queueLimit: number;
  bufferScheduled: number | null;
  appScheduled: number;
  lastSyncedAt: string | null;
}

export interface RunSummary {
  late: number;
  kwaiPending: number;
  bufferPhase: string;
  reconciled: number;
  recovered: number;
  created: number;
  dryRun: number;
  failed: number;
  limitHits: number;
  occupancy: { platform: Platform; used: number | null; limit: number; free: number | null; available: boolean; reason: string | null }[];
  notes: string[];
  apiCalls: number;
}

export interface SchedulerRun {
  id: number;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: RunSummary | null;
  api_calls: number;
  error: string | null;
}

export interface Dashboard {
  now: string;
  timezone: string;
  defaultTimes: string[];
  counts: { episodes: number; episodesWithoutMedia: number; episodesPending: number; jobsByState: Partial<Record<JobState, number>>; manualPending: number };
  upcoming: { id: number; platform: Platform; scheduledAt: string; state: JobState; episodeTitle: string; seriesTitle: string; episodeNumber: number }[];
  channels: ChannelSummary[];
  buffer: {
    configured: boolean;
    organizationSelected: boolean;
    dryRun: boolean;
    autofillPaused: boolean;
    backoffUntil: string | null;
    rateLimit: RateLimitSnapshot | null;
    requestsToday: number;
    dailyBudget: number;
  };
  storage: { assets: number; bytes: number };
  lastRun: SchedulerRun | null;
  warnings: string[];
}

export interface Settings {
  timezone: string;
  defaultTimes: string[];
  calendarDays: number;
  autofillPaused: boolean;
  dryRun: boolean;
  schedulerIntervalMinutes: number;
  smartSync: boolean;
  maxCreatesPerRun: number;
  maxBufferRequestsPerRun: number;
  dailyBufferBudget: number;
  minLeadMinutes: number;
  latePolicy: 'hold' | 'skip';
  maxRetryAttempts: number;
  bufferOrganizationId: string | null;
  youtubeCategoryId: string;
  youtubePrivacy: 'public' | 'unlisted' | 'private';
  youtubeMadeForKids: boolean;
  youtubeNotifySubscribers: boolean;
  instagramShareToFeed: boolean;
  thumbnailOffsetMs: number | null;
  mediaRetentionDays: number;
  mediaAutoCleanup: boolean;
  kwaiReminderMinutes: number;
}

export interface SettingsResponse {
  settings: Settings;
  environment: {
    bufferConfigured: boolean;
    directUploadConfigured: boolean;
    maxUploadBytes: number;
    publicBaseUrl: string | null;
    publicBaseUrlFromEnv: boolean;
  };
  kwaiCalendarUrl: string;
}

export interface KwaiItem {
  jobId: number;
  episodeId: number;
  title: string;
  seriesTitle: string;
  episodeNumber: number;
  scheduledAt: string;
  localDate: string;
  localTime: string;
  state: JobState;
  caption: string;
  mediaPath: string | null;
  mediaFilename: string | null;
  confirmedAt: string | null;
  note: string | null;
}
