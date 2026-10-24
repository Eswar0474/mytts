-- Replace the former Google-account identity with local username/password fields.
-- Existing Google-auth rows are retained as legacy records but cannot be used to
-- sign in until an administrator migrates them to a local account.
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
