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
