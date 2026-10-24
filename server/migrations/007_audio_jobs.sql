CREATE TABLE IF NOT EXISTS audio_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  script_text TEXT NOT NULL,
  model TEXT NOT NULL,
  voice TEXT NOT NULL,
  output_format TEXT NOT NULL CHECK (output_format IN ('mp3', 'wav', 'flac', 'aac', 'ogg')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_chunks INTEGER NOT NULL CHECK (total_chunks > 0),
  completed_chunks INTEGER NOT NULL DEFAULT 0 CHECK (completed_chunks >= 0),
  total_audio_bytes BIGINT NOT NULL DEFAULT 0 CHECK (total_audio_bytes >= 0),
  duration_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  storage_key TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  worker_token TEXT,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audio_jobs_user_created
  ON audio_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audio_jobs_worker_queue
  ON audio_jobs (status, heartbeat_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_jobs_one_active_per_user
  ON audio_jobs (user_id)
  WHERE status IN ('queued', 'running');
