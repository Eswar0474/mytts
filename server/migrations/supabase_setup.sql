-- Sonora Voice Studio — Supabase Setup Script
-- You can run this script directly in the Supabase SQL Editor (Dashboard -> SQL Editor)
-- or let Sonora apply migrations automatically upon connection.

-- 1. Schema Migrations Table
CREATE TABLE IF NOT EXISTS sonora_schema_migrations (
  migration TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Daily Word Usage Quota Table
CREATE TABLE IF NOT EXISTS daily_word_usage (
  usage_date DATE NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('ip', 'user')),
  subject_hash CHAR(64) NOT NULL,
  words_used INTEGER NOT NULL CHECK (words_used >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usage_date, subject_type, subject_hash)
);

CREATE INDEX IF NOT EXISTS idx_daily_word_usage_date ON daily_word_usage (usage_date);

-- Upgrade databases created with the original 1,000-word storage constraint.
ALTER TABLE daily_word_usage
  DROP CONSTRAINT IF EXISTS daily_word_usage_words_used_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'daily_word_usage'::regclass
      AND conname = 'daily_word_usage_words_used_nonnegative'
  ) THEN
    ALTER TABLE daily_word_usage
      ADD CONSTRAINT daily_word_usage_words_used_nonnegative
      CHECK (words_used >= 0);
  END IF;
END $$;

-- Mark base migration as applied
INSERT INTO sonora_schema_migrations (migration)
VALUES ('001_daily_word_usage.sql'), ('005_expand_daily_word_quota.sql')
ON CONFLICT (migration) DO NOTHING;

-- 3. Users Table (local username/password accounts)
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  expire_date TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrade an older database that still has Google-account columns.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'google_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE users RENAME COLUMN google_id TO user_id;
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci
  ON users (LOWER(username))
  WHERE username IS NOT NULL;

INSERT INTO sonora_schema_migrations (migration)
VALUES ('002_users.sql'), ('003_add_expire_date_to_users.sql'), ('006_local_auth.sql'), ('007_audio_jobs.sql')
ON CONFLICT (migration) DO NOTHING;

-- 4. Durable audio-job metadata. Audio bytes are stored outside Supabase in the
-- Hugging Face Storage Bucket mounted at /data/audio.
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

-- 5. Session Store Table (for local username/password sessions with connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
