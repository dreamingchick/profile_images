PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  ratio TEXT NOT NULL DEFAULT '1:1',
  consent INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0,1)),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewing','working','completed','on_hold','rejected')),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_recent ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_public ON requests(published,created_at DESC);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reference','result')),
  storage_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_request ON images(request_id,kind,position);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_recent ON prompts(created_at DESC);

CREATE TABLE IF NOT EXISTS quotas (
  id INTEGER PRIMARY KEY CHECK (id=1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes>=0),
  uploads_disabled INTEGER NOT NULL DEFAULT 0 CHECK (uploads_disabled IN (0,1))
);
INSERT OR IGNORE INTO quotas (id,used_bytes,uploads_disabled) VALUES (1,0,0);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);