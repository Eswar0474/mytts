CREATE TABLE IF NOT EXISTS daily_word_usage (
  usage_date DATE NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('ip', 'user')),
  subject_hash CHAR(64) NOT NULL,
  words_used INTEGER NOT NULL CHECK (words_used >= 0 AND words_used <= 1000),
  PRIMARY KEY (usage_date, subject_type, subject_hash)
);
