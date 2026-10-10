import { describe, expect, it } from "vitest";
import {
  benchmarkFor,
  compareNullable,
  dailyChangePct,
  filterCompanies,
  formatMarketCap,
  formatPercent,
  formatPp,
  formatPrice,
  relativePerformancePp,
  sortRows,
  trendOf,
} from "../../shared/calc";
import { allCompanies, allTickers, benchmarkTickers, dashboardConfig } from "../../shared/config";
import { exchangeDate, isUsMarketOpen } from "../../shared/market-hours";
import type { StockRow } from "../../shared/types";

const row = (over: Partial<StockRow>): StockRow => ({
  ticker: "X", name: "X", category: "pharma", isBenchmark: false, benchmarkTicker: "PPH", price: null, prevClose: null,
  changePct: null, relativePp: null, sparkline: null, marketCap: null, quoteTime: null, fetchedAt: null, stale: false, ...over,
});

describe("calculations", () => {
  it("daily change is (latest / previous close - 1) * 100", () => {
    expect(dailyChangePct(103, 100)).toBeCloseTo(3);
    expect(dailyChangePct(95, 100)).toBeCloseTo(-5);
  });

  it("daily change is null, not zero, when an input is missing or invalid", () => {
    for (const [p, c] of [[null, 100], [100, null], [100, 0], [0, 100], [NaN, 100]] as const) expect(dailyChangePct(p, c)).toBeNull();
  });

  it("relative performance is a percentage-point difference: +3.0% vs +1.0% = +2.0 pp", () => {
    expect(relativePerformancePp(3, 1)).toBeCloseTo(2);
    expect(formatPp(relativePerformancePp(3, 1))).toBe("+2.00 pp");
    expect(relativePerformancePp(-1, 2)).toBeCloseTo(-3);
    expect(relativePerformancePp(null, 1)).toBeNull();
    expect(relativePerformancePp(1, null)).toBeNull();
  });

  it("maps each category to its own benchmark", () => {
    expect(benchmarkFor("pharma")).toBe("PPH");
    expect(benchmarkFor("biotech")).toBe("XBI");
  });
});

describe("formatting", () => {
  it("shows N/A for missing values, never zero", () => {
    expect(formatPrice(null)).toBe("N/A");
    expect(formatPercent(null)).toBe("N/A");
    expect(formatPp(undefined)).toBe("N/A");
    expect(formatMarketCap(null)).toBe("N/A");
    expect(formatMarketCap(0)).toBe("N/A");
  });

  it("uses consistent precision and explicit signs", () => {
    expect(formatPrice(1234.5)).toBe("1,234.50");
    expect(formatPercent(1.234)).toBe("+1.23%");
    expect(formatPercent(-0.5)).toBe("−0.50%");
    expect(formatPercent(-0.001)).toBe("0.00%");
    expect(trendOf(-0.001)).toBe("flat");
  });

  it("scales market cap with K, M, B and T", () => {
    expect(formatMarketCap(7.5e3)).toBe("$7.50K");
    expect(formatMarketCap(4.2e6)).toBe("$4.20M");
    expect(formatMarketCap(3.1e9)).toBe("$3.10B");
    expect(formatMarketCap(1.05e12)).toBe("$1.05T");
  });
});

describe("sorting and filtering", () => {
  const rows = [row({ ticker: "A", changePct: 1 }), row({ ticker: "B", changePct: null }), row({ ticker: "C", changePct: -2 }), row({ ticker: "D", changePct: 5 })];

  it("sorts numbers in both directions with missing values always last", () => {
    expect(sortRows(rows, "changePct", "asc").map((r) => r.ticker)).toEqual(["C", "A", "D", "B"]);
    expect(sortRows(rows, "changePct", "desc").map((r) => r.ticker)).toEqual(["D", "A", "C", "B"]);
  });

  it("sorts text and leaves the input untouched", () => {
    expect(sortRows(rows, "ticker", "desc").map((r) => r.ticker)).toEqual(["D", "C", "B", "A"]);
    expect(rows.map((r) => r.ticker)).toEqual(["A", "B", "C", "D"]);
    expect(compareNullable(null, null, "asc")).toBe(0);
  });

  it("filters by category and never returns benchmark rows", () => {
    const mixed = [row({ ticker: "PPH", isBenchmark: true }), row({ ticker: "P1" }), row({ ticker: "B1", category: "biotech" })];
    expect(filterCompanies(mixed, "all").map((r) => r.ticker)).toEqual(["P1", "B1"]);
    expect(filterCompanies(mixed, "pharma").map((r) => r.ticker)).toEqual(["P1"]);
    expect(filterCompanies(mixed, "biotech").map((r) => r.ticker)).toEqual(["B1"]);
  });
});

describe("configuration", () => {
  it("has 18 companies and 2 benchmarks, with benchmarks kept out of the watchlist", () => {
    expect(allCompanies()).toHaveLength(18);
    expect(benchmarkTickers()).toEqual(["PPH", "XBI"]);
    expect(allTickers()).toHaveLength(20);
    expect(allCompanies().some((c) => benchmarkTickers().includes(c.ticker))).toBe(false);
  });

  it("marks the foreign private issuers as 6-K filers", () => {
    const sixK = allCompanies().filter((c) => c.filerType === "6-K").map((c) => c.ticker).sort();
    expect(sixK).toEqual(["ARGX", "AZN", "GSK", "NVO"]);
  });

  it("contains nothing that looks like a secret", () => {
    expect(JSON.stringify(dashboardConfig)).not.toMatch(/key|token|secret|password/i);
  });
});

describe("market hours", () => {
  it("is open only during the regular New York session, in summer and winter time", () => {
    expect(isUsMarketOpen(new Date("2026-10-07T14:00:00Z"))).toBe(true); // Wed 10:00 EDT
    expect(isUsMarketOpen(new Date("2026-10-07T13:00:00Z"))).toBe(false); // 09:00 EDT
    expect(isUsMarketOpen(new Date("2026-10-07T20:00:00Z"))).toBe(false); // 16:00 EDT, closed
    expect(isUsMarketOpen(new Date("2026-12-02T14:45:00Z"))).toBe(true); // Wed 09:45 EST
    expect(isUsMarketOpen(new Date("2026-12-02T14:15:00Z"))).toBe(false); // 09:15 EST
    expect(isUsMarketOpen(new Date("2026-10-10T15:00:00Z"))).toBe(false); // Saturday
  });

  it("derives the trading date in exchange time", () => {
    expect(exchangeDate(Date.parse("2026-10-08T01:00:00Z") / 1000)).toBe("2026-10-07");
  });
});
