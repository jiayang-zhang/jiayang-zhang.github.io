export type Category = "pharma" | "biotech";

export interface WatchlistCompany {
  ticker: string;
  name: string;
  cik: number;
  filerType: "8-K" | "6-K";
  aliases: string[];
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
