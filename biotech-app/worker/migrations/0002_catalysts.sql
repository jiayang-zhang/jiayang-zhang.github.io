-- Catalyst calendar. Dates are YYYY-MM-DD; timestamps are Unix seconds.
-- origin = 'manual': entered by the administrator.
-- origin = 'registry': generated from ClinicalTrials.gov and replaced on each sync.
CREATE TABLE catalysts (
  id                   TEXT PRIMARY KEY,
  ticker               TEXT NOT NULL,
  program              TEXT NOT NULL,
  indication           TEXT,
  event_type           TEXT NOT NULL CHECK (event_type IN ('pdufa', 'readout', 'adcom')),
  date_start           TEXT NOT NULL,
  date_end             TEXT,
  status               TEXT NOT NULL CHECK (status IN ('confirmed', 'estimated', 'unverified')),
  origin               TEXT NOT NULL CHECK (origin IN ('manual', 'registry')),
  nct_id               TEXT,
  phase                TEXT,
  source_url           TEXT,
  source_name          TEXT,
  notes                TEXT,
  last_verified_at     INTEGER,
  previous_date_start  TEXT,
  date_changed_at      INTEGER,
  registry_date_type   TEXT CHECK (registry_date_type IN ('ANTICIPATED', 'ACTUAL')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX catalysts_by_date ON catalysts (date_start);
CREATE UNIQUE INDEX catalysts_registry_trial ON catalysts (nct_id) WHERE origin = 'registry';
