CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER,            -- NULL = top level (home page lives here)
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '{}',
  is_home INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS file_chunks (
  name TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (name, idx)
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'Post-growth Sverige');
-- Admin accounts and one-time links (invites and password resets).
CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY,           -- lowercase
  password_hash TEXT,               -- NULL until the invite is accepted
  invited_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,            -- 'invite' | 'reset'
  expires_at INTEGER NOT NULL
);
