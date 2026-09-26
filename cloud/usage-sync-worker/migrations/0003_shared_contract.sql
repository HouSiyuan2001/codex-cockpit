ALTER TABLE spaces ADD COLUMN shared_settings TEXT;
ALTER TABLE spaces ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN sync_info TEXT;
ALTER TABLE members ADD COLUMN heartbeat_at INTEGER;
