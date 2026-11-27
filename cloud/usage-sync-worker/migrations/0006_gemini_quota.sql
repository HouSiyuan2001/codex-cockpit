CREATE TABLE gemini_quota_snapshots (
  space_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (space_id, device_id),
  FOREIGN KEY (space_id, device_id) REFERENCES members(space_id, device_id) ON DELETE CASCADE
);
