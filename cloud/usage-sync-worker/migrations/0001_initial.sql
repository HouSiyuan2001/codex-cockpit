PRAGMA foreign_keys = ON;

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (space_id, device_id)
);

CREATE INDEX members_space_idx ON members(space_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 20),
  uses INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE snapshots (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, device_id),
  FOREIGN KEY (space_id, device_id) REFERENCES members(space_id, device_id) ON DELETE CASCADE
);
