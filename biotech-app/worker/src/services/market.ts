import { benchmarkFor, dailyChangePct, relativePerformancePp } from "../../../shared/calc";
import { allCompanies, allTickers, dashboardConfig } from "../../../shared/config";
import { exchangeDate, isUsMarketOpen } from "../../../shared/market-hours";
import type { Category, DataSource, MarketSnapshot, StockRow } from "../../../shared/types";
import {
  getJobStatus,
  loadCloses,
  loadProfiles,
  loadQuotes,
  recordJobRun,
  saveProfiles,
  saveQuotes,
  type CloseRecord,
  type ProfileRecord,
  type QuoteRecord,
} from "../db";
import { dedupe, mapLimit, UpstreamError } from "../lib/http";
import type { MarketDataProvider } from "../providers/types";

const PRICES_JOB = "prices";
const PROFILES_JOB = "profiles";
const SNAPSHOT_TTL_MS = 20_000;
const CLOSED_STALE_SECONDS = 4 * 86_400; // a long weekend

export interface RefreshResult {
  ran: boolean;
  reason?: "market_closed";
  updated: number;
  failed: string[];
}

function summarise(failed: string[], total: number, reasons: unknown[]): string | null {
  if (failed.length === 0) return null;
  // Only error kinds are recorded; never raw messages from a provider.
  const kinds = [...new Set(reasons.map((r) => (r instanceof UpstreamError ? r.kind : "error")))].sort();
  return `${failed.length} of ${total} tickers failed (${kinds.join(", ") || "no data"})`;
}

/**
 * Polls quotes for every ticker. Outside market hours it runs once after the
 * session ends, to record official closes, and is otherwise a no-op unless forced.
 */
export async function refreshPrices(db: D1Database, provider: MarketDataProvider, opts: { force?: boolean; now?: Date } = {}): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const open = isUsMarketOpen(now);

  if (!opts.force && !open) {
    const status = await getJobStatus(db, PRICES_JOB);
    const last = status?.last_attempt_at ?? null;
    const closingRunDue = last === null || isUsMarketOpen(new Date(last * 1000));
    if (!closingRunDue) return { ran: false, reason: "market_closed", updated: 0, failed: [] };
  }

  const tickers = allTickers();
  const results = await mapLimit(tickers, dashboardConfig.network.providerConcurrency, (t) => provider.getQuote(t));

  const quotes: QuoteRecord[] = [];
  const closes: CloseRecord[] = [];
  const failed: string[] = [];
  const reasons: unknown[] = [];
  results.forEach((r, i) => {
    const ticker = tickers[i]!;
    if (r.status === "rejected") {
      failed.push(ticker);
      reasons.push(r.reason);
      return;
    }
    if (r.value === null) {
      failed.push(ticker);
      return;
    }
    const q = r.value;
    quotes.push({ ticker, price: q.price, prev_close: q.prevClose, quote_time: q.quoteTime, fetched_at: nowS, source: provider.source });
    if (!open && q.quoteTime !== null) {
      closes.push({ ticker, trade_date: exchangeDate(q.quoteTime), close: q.price, source: provider.source });
    }
  });

  await saveQuotes(db, quotes, closes);
  await recordJobRun(db, PRICES_JOB, nowS, failed.length, summarise(failed, tickers.length, reasons));
  clearSnapshotCache();
  return { ran: true, updated: quotes.length, failed };
}

/** Market capitalisation changes slowly; refreshed once a day. Benchmarks are ETFs and have none. */
export async function refreshProfiles(db: D1Database, provider: MarketDataProvider, opts: { now?: Date } = {}): Promise<RefreshResult> {
  const nowS = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const tickers = allCompanies().map((c) => c.ticker);
  const results = await mapLimit(tickers, dashboardConfig.network.providerConcurrency, (t) => provider.getProfile(t));

  const profiles: ProfileRecord[] = [];
  const failed: string[] = [];
  const reasons: unknown[] = [];
  results.forEach((r, i) => {
    const ticker = tickers[i]!;
    if (r.status === "rejected") {
      failed.push(ticker);
      reasons.push(r.reason);
    } else if (r.value === null) {
      failed.push(ticker);
    } else {
      profiles.push({ ticker, market_cap: r.value.marketCap, currency: r.value.currency, fetched_at: nowS, source: provider.source });
    }
  });

  await saveProfiles(db, profiles);
  await recordJobRun(db, PROFILES_JOB, nowS, failed.length, summarise(failed, tickers.length, reasons));
  clearSnapshotCache();
  return { ran: true, updated: profiles.length, failed };
}

function buildSparkline(closes: CloseRecord[], quote: QuoteRecord | undefined): number[] | null {
  const points = closes.map((c) => c.close);
  // Add the latest price as the final point when it belongs to a later session than the last stored close.
  if (quote && quote.quote_time !== null) {
    const lastDate = closes.at(-1)?.trade_date;
    if (!lastDate || exchangeDate(quote.quote_time) > lastDate) points.push(quote.price);
  }
  const window = points.slice(-dashboardConfig.market.sparklineDays);
  return window.length >= 2 ? window : null;
}

export async function buildSnapshot(db: D1Database, opts: { now?: Date; defaultSource?: DataSource } = {}): Promise<MarketSnapshot> {
  const now = opts.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const open = isUsMarketOpen(now);
  const since = new Date(now.getTime() - 21 * 86_400_000).toISOString().slice(0, 10);

  const [quoteRows, profileRows, closeRows, status] = await Promise.all([loadQuotes(db), loadProfiles(db), loadCloses(db, since), getJobStatus(db, PRICES_JOB)]);
  const quotes = new Map(quoteRows.map((q) => [q.ticker, q]));
  const profiles = new Map(profileRows.map((p) => [p.ticker, p]));
  const closesByTicker = new Map<string, CloseRecord[]>();
  for (const c of closeRows) closesByTicker.set(c.ticker, [...(closesByTicker.get(c.ticker) ?? []), c]);

  const staleAfter = open ? (dashboardConfig.market.staleAfterIntervals * dashboardConfig.refreshIntervals.pricesMs) / 1000 : CLOSED_STALE_SECONDS;

  const base = (ticker: string, name: string, category: Category, isBenchmark: boolean): StockRow => {
    const q = quotes.get(ticker);
    const p = profiles.get(ticker);
    return {
      ticker,
      name,
      category,
      isBenchmark,
      benchmarkTicker: benchmarkFor(category),
      price: q?.price ?? null,
      prevClose: q?.prev_close ?? null,
      changePct: dailyChangePct(q?.price, q?.prev_close),
      relativePp: null,
      sparkline: buildSparkline(closesByTicker.get(ticker) ?? [], q),
      // Shown only when reported in the display currency; no FX conversion is attempted.
      marketCap: p && p.currency === dashboardConfig.display.currency ? p.market_cap : null,
      quoteTime: q?.quote_time ?? null,
      fetchedAt: q?.fetched_at ?? null,
      stale: q ? nowS - q.fetched_at > staleAfter : false,
    };
  };

  const benchmarks = (Object.keys(dashboardConfig.benchmarks) as Category[]).map((category) => {
    const b = dashboardConfig.benchmarks[category];
    return base(b.ticker, b.name, category, true);
  });
  const benchmarkByTicker = new Map(benchmarks.map((b) => [b.ticker, b]));

  const companies = allCompanies().map((c) => {
    const row = base(c.ticker, c.name, c.category, false);
    const bench = benchmarkByTicker.get(row.benchmarkTicker);
    // Compare only quotes from the same trading session.
    const sameSession =
      bench !== undefined && row.quoteTime !== null && bench.quoteTime !== null && exchangeDate(row.quoteTime) === exchangeDate(bench.quoteTime);
    row.relativePp = sameSession ? relativePerformancePp(row.changePct, bench.changePct) : null;
    return row;
  });

  const anyMock = [...quoteRows, ...profileRows].some((r) => r.source === "mock");
  return {
    source: anyMock ? "mock" : (opts.defaultSource ?? "live"),
    generatedAt: nowS,
    marketOpen: open,
    lastSuccessAt: status?.last_success_at ?? null,
    lastAttemptAt: status?.last_attempt_at ?? null,
    lastRefreshFailed: (status?.failed_count ?? 0) > 0,
    benchmarks,
    companies,
  };
}

let cached: { at: number; snapshot: MarketSnapshot } | null = null;

export function clearSnapshotCache(): void {
  cached = null;
}

/** Shared across visitors: reads come from D1 through a short in-memory cache and never reach the provider. */
export async function getSnapshot(db: D1Database, defaultSource: DataSource): Promise<MarketSnapshot> {
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot;
  return dedupe("market-snapshot", async () => {
    const snapshot = await buildSnapshot(db, { defaultSource });
    cached = { at: Date.now(), snapshot };
    return snapshot;
  });
}
