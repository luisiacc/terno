-- plan 96: the waitlist: Windows, Linux, Intel Macs, and the first Apple-silicon build (/download/ while none is published). Email, platform and when; nothing else. Rows are deleted after the launch email.
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'linux', 'mac', 'mac-intel')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, platform)
);
