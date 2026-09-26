CREATE TABLE daily_plans (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  day TEXT NOT NULL,
  cycle TEXT NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(space_id, day, cycle)
);
