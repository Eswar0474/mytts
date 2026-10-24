-- The original quota table limited cumulative usage to 1,000 words.
-- Per-request limits are enforced by the application. Usage storage is
-- informational and must allow cumulative totals beyond a single request.
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
