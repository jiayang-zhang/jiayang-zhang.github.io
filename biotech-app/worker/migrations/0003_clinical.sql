-- Clinical trial intelligence feed. Dates are YYYY-MM-DD; timestamps are Unix seconds.

-- One row per source document (filing, feed item or registry change). The
-- state column drives ingestion and guarantees each document is classified once.
--   discovered  -> known, not fetched yet
--   fetched     -> text stored, passed the pre-filter, awaiting classification
--   classified  -> classifier ran (model and prompt version recorded)
--   unclassified-> queued for manual categorisation without a classifier
--   excluded    -> discarded by a rule, with the reason
--   error       -> gave up after repeated failures
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('edgar', 'news', 'registry')),
  ticker          TEXT NOT NULL,
  form            TEXT,
  accession       TEXT,
  primary_document TEXT,
  items           TEXT,
  title           TEXT,
  url             TEXT NOT NULL,
  published_date  TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('discovered', 'fetched', 'classified', 'unclassified', 'excluded', 'error')),
  state_reason    TEXT,
  body            TEXT,
  truncated       INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  model           TEXT,
  prompt_version  TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  classified_at   INTEGER,
  retrieved_at    INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX documents_by_state ON documents (state, published_date);

-- One row per underlying clinical event. category is NULL for candidates that
-- still need a person to categorise them; those are never public.
CREATE TABLE events (
  id                  TEXT PRIMARY KEY,
  ticker              TEXT NOT NULL,
  category            TEXT CHECK (category IN ('phase2_success', 'phase2_failure', 'phase3_initiation', 'phase3_success', 'phase3_failure')),
  phase               TEXT CHECK (phase IN ('1/2', '2', '2/3', '3')),
  program             TEXT,
  program_key         TEXT,
  indication          TEXT,
  summary             TEXT,
  evidence_basis      TEXT,
  nct_id              TEXT,
  announcement_date   TEXT NOT NULL,
  event_date          TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'rejected')),
  excerpt             TEXT,
  note                TEXT,
  termination_reason  TEXT,
  origin              TEXT NOT NULL CHECK (origin IN ('llm', 'manual', 'registry')),
  model               TEXT,
  prompt_version      TEXT,
  truncated           INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at   INTEGER NOT NULL,
  reviewed_at         INTEGER,
  reviewed_by         TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX events_public ON events (status, announcement_date);
CREATE INDEX events_dedupe ON events (ticker, category);

-- Every source that reported an event; the most authoritative is shown as primary.
CREATE TABLE event_sources (
  event_id     TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('edgar', 'news', 'registry')),
  url          TEXT NOT NULL,
  label        TEXT NOT NULL,
  date         TEXT,
  PRIMARY KEY (event_id, document_id)
);

-- Last seen registry status per trial, to detect changes.
CREATE TABLE trial_status (
  nct_id          TEXT PRIMARY KEY,
  ticker          TEXT NOT NULL,
  overall_status  TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);
