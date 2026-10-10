import { beforeEach, describe, expect, it, vi } from "vitest";
import { allTickers } from "../../shared/config";
import { UpstreamError } from "../../worker/src/lib/http";
import type { MarketDataProvider, ProviderQuote } from "../../worker/src/providers/types";
import { createMockProvider } from "../../worker/src/providers/mock";
import { buildSnapshot, clearSnapshotCache, refreshPrices, refreshProfiles } from "../../worker/src/services/market";
import { createTestDb } from "./d1";

const OPEN = new Date("2026-10-07T15:00:00Z"); // Wed 11:00 New York
const AFTER_CLOSE = new Date("2026-10-07T20:05:00Z"); // Wed 16:05
const EVENING = new Date("2026-10-07T20:10:00Z");
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

function provider(quotes: Record<string, ProviderQuote | null | Error>, fallback?: ProviderQuote): MarketDataProvider & { calls: number } {
  const p = {
    source: "live" as const,
    calls: 0,
    async getQuote(ticker: string) {
      p.calls++;
      const q = ticker in quotes ? quotes[ticker]! : (fallback ?? null);
      if (q instanceof Error) throw q;
      return q;
    },
    async getProfile(ticker: string) {
      return ticker === "NVO" ? { marketCap: 2e12, currency: "DKK" } : { marketCap: 5e9, currency: "USD" };
    },
  };
  return p;
}

const q = (price: number, prevClose: number, at = OPEN): ProviderQuote => ({ price, prevClose, quoteTime: secs(at) });

let db: D1Database;
beforeEach(() => {
  db = createTestDb();
  clearSnapshotCache();
});

describe("snapshot calculations", () => {
  it("measures each company against its own category benchmark, in percentage points", async () => {
    await refreshPrices(db, provider({ PPH: q(101, 100), XBI: q(98, 100), LLY: q(103, 100), VKTX: q(99, 100) }, q(50, 50)), { now: OPEN });
    const s = await buildSnapshot(db, { now: OPEN });

    expect(s.benchmarks.map((b) => b.ticker)).toEqual(["PPH", "XBI"]);
    expect(s.benchmarks.every((b) => b.isBenchmark && b.relativePp === null)).toBe(true);
    expect(s.companies).toHaveLength(18);
    expect(s.companies.some((c) => c.ticker === "PPH" || c.ticker === "XBI")).toBe(false);

    const lly = s.companies.find((c) => c.ticker === "LLY")!;
    expect(lly.benchmarkTicker).toBe("PPH");
    expect(lly.changePct).toBeCloseTo(3);
    expect(lly.relativePp).toBeCloseTo(2); // +3.0% vs +1.0%

    const vktx = s.companies.find((c) => c.ticker === "VKTX")!;
    expect(vktx.benchmarkTicker).toBe("XBI");
    expect(vktx.relativePp).toBeCloseTo(1); // -1.0% vs -2.0%
  });

  it("leaves missing data null rather than zero", async () => {
    await refreshPrices(db, provider({ PPH: q(101, 100), LLY: { price: 50, prevClose: null, quoteTime: secs(OPEN) } }), { now: OPEN });
    const s = await buildSnapshot(db, { now: OPEN });
    const lly = s.companies.find((c) => c.ticker === "LLY")!;
    expect(lly.price).toBe(50);
    expect(lly.changePct).toBeNull();
    expect(lly.relativePp).toBeNull();
    const mrk = s.companies.find((c) => c.ticker === "MRK")!;
    expect([mrk.price, mrk.changePct, mrk.relativePp, mrk.marketCap, mrk.sparkline]).toEqual([null, null, null, null, null]);
  });

  it("does not compare quotes from different trading sessions", async () => {
    const yesterday = new Date("2026-10-06T19:59:00Z");
    await refreshPrices(db, provider({ PPH: q(101, 100, OPEN), LLY: q(103, 100, yesterday) }), { now: OPEN });
    const lly = (await buildSnapshot(db, { now: OPEN })).companies.find((c) => c.ticker === "LLY")!;
    expect(lly.changePct).toBeCloseTo(3);
    expect(lly.relativePp).toBeNull();
  });

  it("shows market cap only in the display currency", async () => {
    const p = provider({}, q(10, 10));
    await refreshProfiles(db, p, { now: OPEN });
    const s = await buildSnapshot(db, { now: OPEN });
    expect(s.companies.find((c) => c.ticker === "LLY")!.marketCap).toBe(5e9);
    expect(s.companies.find((c) => c.ticker === "NVO")!.marketCap).toBeNull();
    expect(s.benchmarks.every((b) => b.marketCap === null)).toBe(true);
  });
});

describe("refresh policy and API budget", () => {
  it("makes exactly one quote call per ticker per refresh", async () => {
    const p = provider({}, q(10, 10));
    const r = await refreshPrices(db, p, { now: OPEN });
    expect(r).toMatchObject({ ran: true, updated: 20, failed: [] });
    expect(p.calls).toBe(allTickers().length);
  });

  it("runs once after the close, then stops polling until the next session", async () => {
    const p = provider({}, q(10, 10));
    await refreshPrices(db, p, { now: OPEN });
    expect((await refreshPrices(db, p, { now: AFTER_CLOSE })).ran).toBe(true);
    const callsAfterClose = p.calls;
    expect(await refreshPrices(db, p, { now: EVENING })).toMatchObject({ ran: false, reason: "market_closed" });
    expect(await refreshPrices(db, p, { now: new Date("2026-10-10T15:00:00Z") })).toMatchObject({ ran: false });
    expect(p.calls).toBe(callsAfterClose);
    expect((await refreshPrices(db, p, { now: EVENING, force: true })).ran).toBe(true);
  });

  it("records official closes after the session and builds the sparkline from them", async () => {
    const days = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"];
    for (const [i, day] of days.entries()) {
      const close = new Date(`${day}T20:05:00Z`);
      const lastTrade = new Date(`${day}T20:00:00Z`);
      await refreshPrices(db, provider({}, q(100 + i, 100, lastTrade)), { now: close, force: true });
    }
    const s = await buildSnapshot(db, { now: AFTER_CLOSE });
    expect(s.companies.find((c) => c.ticker === "LLY")!.sparkline).toEqual([100, 101, 102, 103, 104]);

    // During the next session the live price becomes the last point.
    const next = new Date("2026-10-08T15:00:00Z");
    await refreshPrices(db, provider({}, q(110, 104, next)), { now: next });
    expect((await buildSnapshot(db, { now: next })).companies.find((c) => c.ticker === "LLY")!.sparkline).toEqual([101, 102, 103, 104, 110]);
  });

  it("does not store intraday prices as closes", async () => {
    await refreshPrices(db, provider({}, q(10, 10)), { now: OPEN });
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM daily_closes").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});

describe("failure handling", () => {
  it("keeps the previous quote and flags the failure when a provider call fails", async () => {
    await refreshPrices(db, provider({}, q(10, 10)), { now: OPEN });
    const later = new Date(OPEN.getTime() + 5 * 60_000);
    const r = await refreshPrices(db, provider({ LLY: new UpstreamError("rate_limited", 429), XBI: null }, q(11, 10, later)), { now: later });
    expect(r.failed.sort()).toEqual(["LLY", "XBI"]);
    expect(r.updated).toBe(18);

    const s = await buildSnapshot(db, { now: later });
    expect(s.lastRefreshFailed).toBe(true);
    expect(s.lastSuccessAt).toBe(secs(OPEN));
    expect(s.lastAttemptAt).toBe(secs(later));
    expect(s.companies.find((c) => c.ticker === "LLY")!.price).toBe(10);
    expect(s.companies.find((c) => c.ticker === "MRK")!.price).toBe(11);

    const status = await db.prepare("SELECT last_error FROM job_status WHERE job = 'prices'").first<{ last_error: string }>();
    expect(status!.last_error).toBe("2 of 20 tickers failed (rate_limited)");
  });

  it("serves an empty snapshot when the provider is down from the start", async () => {
    const down = provider(Object.fromEntries(allTickers().map((t) => [t, new UpstreamError("timeout")])));
    const r = await refreshPrices(db, down, { now: OPEN });
    expect(r.updated).toBe(0);
    const s = await buildSnapshot(db, { now: OPEN });
    expect(s.lastSuccessAt).toBeNull();
    expect(s.lastRefreshFailed).toBe(true);
    expect([...s.benchmarks, ...s.companies].every((row) => row.price === null)).toBe(true);
  });

  it("marks quotes stale when they are older than three refresh intervals during the session", async () => {
    await refreshPrices(db, provider({}, q(10, 10)), { now: OPEN });
    const fresh = await buildSnapshot(db, { now: new Date(OPEN.getTime() + 10 * 60_000) });
    expect(fresh.companies.every((c) => !c.stale)).toBe(true);
    const old = await buildSnapshot(db, { now: new Date(OPEN.getTime() + 20 * 60_000) });
    expect(old.companies.every((c) => c.stale)).toBe(true);
  });
});

describe("mock data", () => {
  it("is labelled as mock in the snapshot and never as live", async () => {
    await refreshPrices(db, createMockProvider(() => OPEN.getTime()), { now: OPEN });
    expect((await buildSnapshot(db, { now: OPEN })).source).toBe("mock");
  });

  it("stays labelled mock while any mock row remains", async () => {
    await refreshPrices(db, createMockProvider(() => OPEN.getTime()), { now: OPEN });
    await refreshPrices(db, provider({ LLY: q(10, 10) }), { now: OPEN });
    expect((await buildSnapshot(db, { now: OPEN })).source).toBe("mock");
  });

  it("reports live for live rows", async () => {
    await refreshPrices(db, provider({}, q(10, 10)), { now: OPEN });
    expect((await buildSnapshot(db, { now: OPEN })).source).toBe("live");
    vi.restoreAllMocks();
  });
});
