-- plan 96: the Windows/Linux waitlist. Email, platform and when; nothing else. Rows are deleted after the launch email.
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'linux', 'mac')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, platform)
);
