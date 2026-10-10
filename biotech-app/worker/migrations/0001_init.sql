-- Latest quote per ticker. Timestamps are Unix seconds.
CREATE TABLE quotes (
  ticker      TEXT PRIMARY KEY,
  price       REAL NOT NULL,
  prev_close  REAL,
  quote_time  INTEGER,
  fetched_at  INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('live', 'mock'))
);

CREATE TABLE profiles (
  ticker      TEXT PRIMARY KEY,
  market_cap  REAL,
  currency    TEXT,
  fetched_at  INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('live', 'mock'))
);

-- One official close per trading day, recorded after the session ends.
-- This is the sparkline's history; prices are as reported, not split-adjusted.
CREATE TABLE daily_closes (
  ticker      TEXT NOT NULL,
  trade_date  TEXT NOT NULL,
  close       REAL NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('live', 'mock')),
  PRIMARY KEY (ticker, trade_date)
);

CREATE TABLE job_status (
  job              TEXT PRIMARY KEY,
  last_attempt_at  INTEGER,
  last_success_at  INTEGER,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT
);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT
);
