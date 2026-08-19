CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_entries (
  capture_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 7),
  name TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  confidence REAL,
  PRIMARY KEY (capture_id, rank),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_captures_captured_at_ms
ON captures(captured_at_ms);
