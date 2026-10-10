import type { DataSource } from "../../shared/types";

export interface QuoteRecord {
  ticker: string;
  price: number;
  prev_close: number | null;
  quote_time: number | null;
  fetched_at: number;
  source: DataSource;
}

export interface ProfileRecord {
  ticker: string;
  market_cap: number | null;
  currency: string | null;
  fetched_at: number;
  source: DataSource;
}

export interface CloseRecord {
  ticker: string;
  trade_date: string;
  close: number;
  source: DataSource;
}

export interface JobStatus {
  job: string;
  last_attempt_at: number | null;
  last_success_at: number | null;
  failed_count: number;
  last_error: string | null;
}

export async function saveQuotes(db: D1Database, quotes: QuoteRecord[], closes: CloseRecord[]): Promise<void> {
  const statements = [
    ...quotes.map((q) =>
      db
        .prepare(
          `INSERT INTO quotes (ticker, price, prev_close, quote_time, fetched_at, source) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(ticker) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close,
             quote_time = excluded.quote_time, fetched_at = excluded.fetched_at, source = excluded.source`,
        )
        .bind(q.ticker, q.price, q.prev_close, q.quote_time, q.fetched_at, q.source),
    ),
    ...closes.map((c) =>
      db
        .prepare(
          `INSERT INTO daily_closes (ticker, trade_date, close, source) VALUES (?, ?, ?, ?)
           ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, source = excluded.source`,
        )
        .bind(c.ticker, c.trade_date, c.close, c.source),
    ),
  ];
  if (statements.length > 0) await db.batch(statements);
}

export async function saveProfiles(db: D1Database, profiles: ProfileRecord[]): Promise<void> {
  if (profiles.length === 0) return;
  await db.batch(
    profiles.map((p) =>
      db
        .prepare(
          `INSERT INTO profiles (ticker, market_cap, currency, fetched_at, source) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(ticker) DO UPDATE SET market_cap = excluded.market_cap, currency = excluded.currency,
             fetched_at = excluded.fetched_at, source = excluded.source`,
        )
        .bind(p.ticker, p.market_cap, p.currency, p.fetched_at, p.source),
    ),
  );
}

export async function loadQuotes(db: D1Database): Promise<QuoteRecord[]> {
  return (await db.prepare("SELECT ticker, price, prev_close, quote_time, fetched_at, source FROM quotes").all<QuoteRecord>()).results;
}

export async function loadProfiles(db: D1Database): Promise<ProfileRecord[]> {
  return (await db.prepare("SELECT ticker, market_cap, currency, fetched_at, source FROM profiles").all<ProfileRecord>()).results;
}

/** Closes on or after `sinceDate` (YYYY-MM-DD), oldest first. */
export async function loadCloses(db: D1Database, sinceDate: string): Promise<CloseRecord[]> {
  return (
    await db
      .prepare("SELECT ticker, trade_date, close, source FROM daily_closes WHERE trade_date >= ? ORDER BY trade_date ASC")
      .bind(sinceDate)
      .all<CloseRecord>()
  ).results;
}

export async function getJobStatus(db: D1Database, job: string): Promise<JobStatus | null> {
  return db.prepare("SELECT job, last_attempt_at, last_success_at, failed_count, last_error FROM job_status WHERE job = ?").bind(job).first<JobStatus>();
}

export async function recordJobRun(db: D1Database, job: string, at: number, failedCount: number, error: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO job_status (job, last_attempt_at, last_success_at, failed_count, last_error) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(job) DO UPDATE SET last_attempt_at = ?2, last_success_at = COALESCE(?3, job_status.last_success_at),
         failed_count = ?4, last_error = ?5`,
    )
    .bind(job, at, failedCount === 0 ? at : null, failedCount, error)
    .run();
}

export async function writeAudit(db: D1Database, at: number, actor: string, action: string, detail: string | null): Promise<void> {
  await db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)").bind(at, actor, action, detail).run();
}
