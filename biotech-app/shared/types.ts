export type Category = "pharma" | "biotech";

export interface WatchlistCompany {
  ticker: string;
  name: string;
  cik: number;
  filerType: "8-K" | "6-K";
  aliases: string[];
  registrySponsors: string[];
}

/** Where the numbers came from. "mock" must always be surfaced in the UI. */
export type DataSource = "live" | "mock";

export interface StockRow {
  ticker: string;
  name: string;
  category: Category;
  isBenchmark: boolean;
  benchmarkTicker: string;
  /** Latest available price; null when the provider had no data. */
  price: number | null;
  prevClose: number | null;
  /** (price / prevClose - 1) * 100 */
  changePct: number | null;
  /** changePct minus the benchmark's changePct, in percentage points. Null for benchmarks. */
  relativePp: number | null;
  /** Daily closes, oldest first; null until enough history is collected. */
  sparkline: number[] | null;
  marketCap: number | null;
  /** Unix seconds of the provider's last trade, and of our fetch. */
  quoteTime: number | null;
  fetchedAt: number | null;
  stale: boolean;
}

export interface MarketSnapshot {
  source: DataSource;
  generatedAt: number;
  marketOpen: boolean;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  /** True when the most recent refresh attempt failed for at least one ticker. */
  lastRefreshFailed: boolean;
  benchmarks: StockRow[];
  companies: StockRow[];
}

export interface AdminSession {
  email: string;
}

export type CatalystType = "pdufa" | "readout" | "adcom";
export type CatalystStatus = "confirmed" | "estimated" | "unverified";
export type CatalystOrigin = "manual" | "registry";

/** Public view of a catalyst. Dates are YYYY-MM-DD. */
export interface Catalyst {
  id: string;
  ticker: string;
  program: string;
  indication: string | null;
  eventType: CatalystType;
  dateStart: string;
  /** Set when the event is expected within a range rather than on one day. */
  dateEnd: string | null;
  status: CatalystStatus;
  origin: CatalystOrigin;
  nctId: string | null;
  phase: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  lastVerifiedAt: number | null;
  previousDateStart: string | null;
  dateChangedAt: number | null;
  /** Registry entries only: whether the primary completion date is anticipated or actual. */
  registryDateType: "ANTICIPATED" | "ACTUAL" | null;
}

/** Admin view: adds fields visitors must not receive. */
export interface AdminCatalyst extends Catalyst {
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CatalystInput {
  ticker: string;
  program: string;
  indication?: string | null;
  eventType: CatalystType;
  dateStart: string;
  dateEnd?: string | null;
  status: CatalystStatus;
  nctId?: string | null;
  sourceUrl?: string | null;
  sourceName?: string | null;
  notes?: string | null;
}

export interface CatalystFeed {
  /** UTC date the feed was computed for. */
  today: string;
  lookAheadDays: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastRefreshFailed: boolean;
  items: Catalyst[];
}
