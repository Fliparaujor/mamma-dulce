-- Histórias Publisher: esquema inicial do D1.
-- Instantes são sempre gravados em UTC no formato ISO 8601 (ex.: 2026-11-01T15:00:00.000Z).
-- profile_id prepara o caminho para mais de um perfil no futuro; hoje só existe 'default'.


CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,              -- JSON
  updated_at  TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  id            TEXT PRIMARY KEY,         -- SHA-256 (hex) do token do cookie; o token em si nunca é gravado
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  ip_hash       TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions (expires_at);

-- Controle de tentativas de login (por IP com hash e uma chave global).
CREATE TABLE login_attempts (
  key            TEXT PRIMARY KEY,
  failures       INTEGER NOT NULL DEFAULT 0,
  window_start   TEXT NOT NULL,
  locked_until   TEXT
);

CREATE TABLE series (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id        TEXT NOT NULL DEFAULT 'default',
  slug              TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  default_hashtags  TEXT NOT NULL DEFAULT '',
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (profile_id, slug)
);

CREATE TABLE media_assets (
  id                 TEXT PRIMARY KEY,     -- UUID
  profile_id         TEXT NOT NULL DEFAULT 'default',
  r2_key             TEXT NOT NULL UNIQUE,
  original_filename  TEXT NOT NULL,
  content_type       TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  fingerprint        TEXT,                 -- impressão digital calculada no navegador (detecção de duplicados)
  duration_ms        INTEGER,
  width              INTEGER,
  height             INTEGER,
  status             TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'failed', 'deleted')),
  upload_mode        TEXT NOT NULL CHECK (upload_mode IN ('presigned', 'multipart', 'proxy')),
  multipart_upload_id TEXT,
  public_token       TEXT NOT NULL,        -- segredo aleatório da URL pública /media/<id>/<token>
  created_at         TEXT NOT NULL,
  uploaded_at        TEXT,
  deleted_at         TEXT
);
CREATE INDEX idx_media_assets_status ON media_assets (status);
CREATE INDEX idx_media_assets_fingerprint ON media_assets (fingerprint);

CREATE TABLE episodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id      TEXT NOT NULL DEFAULT 'default',
  series_id       INTEGER NOT NULL REFERENCES series (id) ON DELETE RESTRICT,
  episode_number  INTEGER NOT NULL CHECK (episode_number > 0),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  media_asset_id  TEXT REFERENCES media_assets (id) ON DELETE SET NULL,
  caption_mode    TEXT NOT NULL DEFAULT 'shared' CHECK (caption_mode IN ('shared', 'custom')),
  shared_caption  TEXT NOT NULL DEFAULT '',
  shared_hashtags TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (series_id, episode_number)
);
CREATE INDEX idx_episodes_media ON episodes (media_asset_id);

-- Configuração por rede de cada episódio (legenda própria, hashtags, título do YouTube, rede ligada/desligada).
CREATE TABLE episode_platforms (
  episode_id  INTEGER NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  platform    TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'kwai')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  caption     TEXT,
  hashtags    TEXT,
  title       TEXT,
  PRIMARY KEY (episode_id, platform)
);

CREATE TABLE social_channels (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id             TEXT NOT NULL DEFAULT 'default',
  platform               TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'kwai')),
  provider               TEXT NOT NULL CHECK (provider IN ('buffer', 'manual')),
  external_id            TEXT,             -- ID do canal no Buffer
  organization_id        TEXT,
  name                   TEXT NOT NULL,
  display_name           TEXT,
  avatar_url             TEXT,
  service                TEXT,
  is_disconnected        INTEGER NOT NULL DEFAULT 0,
  is_locked              INTEGER NOT NULL DEFAULT 0,
  is_queue_paused        INTEGER NOT NULL DEFAULT 0,
  default_to_reminders   INTEGER,          -- metadado do Buffer: canal configurado para lembrete em vez de publicação automática
  enabled                INTEGER NOT NULL DEFAULT 1,
  queue_limit            INTEGER NOT NULL DEFAULT 10 CHECK (queue_limit BETWEEN 0 AND 1000),
  buffer_scheduled_count INTEGER,          -- última ocupação real lida no Buffer
  last_synced_at         TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (profile_id, platform),
  UNIQUE (provider, external_id)
);

-- Uma linha por (episódio, rede). O episódio é o conteúdo; a publicação é o envio para uma rede.
CREATE TABLE publication_jobs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id             TEXT NOT NULL DEFAULT 'default',
  episode_id             INTEGER NOT NULL REFERENCES episodes (id) ON DELETE RESTRICT,
  platform               TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'kwai')),
  channel_id             INTEGER REFERENCES social_channels (id) ON DELETE SET NULL,
  scheduled_at           TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN (
                            'planned',          -- planejado no sistema, ainda não enviado
                            'creating',         -- envio ao Buffer em andamento (resultado ainda não confirmado)
                            'scheduled_buffer', -- agendado no Buffer
                            'manual_pending',   -- ação manual necessária (Kwai ou lembrete do Buffer)
                            'published',        -- publicação confirmada
                            'failed',           -- falhou
                            'needs_attention',  -- atrasado, removido do Buffer ou estado ambíguo
                            'cancelled')),
  buffer_post_id         TEXT UNIQUE,
  buffer_status          TEXT,
  buffer_scheduling_type TEXT,
  buffer_due_at          TEXT,
  create_started_at      TEXT,
  published_at           TEXT,
  external_url           TEXT,
  attention_reason       TEXT,
  last_error             TEXT,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TEXT,
  dry_run_checked_at     TEXT,
  manual_confirmed_at    TEXT,
  manual_note            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
-- Impede duas publicações vivas do mesmo episódio na mesma rede.
CREATE UNIQUE INDEX uq_jobs_episode_platform_active
  ON publication_jobs (episode_id, platform) WHERE state <> 'cancelled';
-- Impede dois episódios no mesmo instante da mesma rede.
CREATE UNIQUE INDEX uq_jobs_platform_slot_active
  ON publication_jobs (profile_id, platform, scheduled_at) WHERE state <> 'cancelled';
CREATE INDEX idx_jobs_state_time ON publication_jobs (state, scheduled_at);
CREATE INDEX idx_jobs_platform_time ON publication_jobs (platform, scheduled_at);

CREATE TABLE scheduler_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger       TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'error', 'skipped')),
  summary       TEXT,                     -- JSON
  api_calls     INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX idx_scheduler_runs_started ON scheduler_runs (started_at);

CREATE TABLE publication_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES publication_jobs (id) ON DELETE CASCADE,
  scheduler_run_id  INTEGER REFERENCES scheduler_runs (id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('create', 'recover', 'reconcile', 'edit', 'delete', 'manual_confirm', 'manual_undo', 'retry', 'dry_run', 'state_change')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'unknown', 'dry_run', 'info')),
  message           TEXT,
  details           TEXT,                 -- JSON sem credenciais
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_attempts_job ON publication_attempts (job_id, created_at);

-- Trava contra execuções simultâneas do agendador.
CREATE TABLE locks (
  name         TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- Contadores diários de uso (requisições ao Buffer, entregas de mídia).
CREATE TABLE usage_daily (
  day     TEXT NOT NULL,                  -- AAAA-MM-DD (UTC)
  metric  TEXT NOT NULL,
  value   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);
