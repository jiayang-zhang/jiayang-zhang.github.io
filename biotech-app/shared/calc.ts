import { dashboardConfig } from "./config";
import type { Category, StockRow } from "./types";

export const NA = "N/A";

function isNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** (latest / previous official close - 1) * 100. Null when either input is unusable. */
export function dailyChangePct(price: number | null | undefined, prevClose: number | null | undefined): number | null {
  if (!isNum(price) || !isNum(prevClose) || prevClose <= 0 || price <= 0) return null;
  return (price / prevClose - 1) * 100;
}

/** Company change minus benchmark change, in percentage points. */
export function relativePerformancePp(companyPct: number | null | undefined, benchmarkPct: number | null | undefined): number | null {
  if (!isNum(companyPct) || !isNum(benchmarkPct)) return null;
  return companyPct - benchmarkPct;
}

export function benchmarkFor(category: Category): string {
  return dashboardConfig.benchmarks[category].ticker;
}

export type SortDirection = "asc" | "desc";
export type SortKey = "ticker" | "name" | "category" | "price" | "changePct" | "relativePp" | "marketCap";

/** Missing values sort last in both directions, so N/A never floats to the top. */
export function compareNullable<T extends number | string>(a: T | null, b: T | null, dir: SortDirection): number {
  const aMissing = a === null || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b === null || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const base = typeof a === "string" ? a.localeCompare(b as string) : (a as number) - (b as number);
  return dir === "asc" ? base : -base;
}

export function sortRows(rows: StockRow[], key: SortKey, dir: SortDirection): StockRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => compareNullable(x.row[key], y.row[key], dir) || x.index - y.index)
    .map((x) => x.row);
}

export type CategoryFilter = "all" | Category;

/** Filters companies only; benchmark rows are handled separately and never pass through here. */
export function filterCompanies(rows: StockRow[], filter: CategoryFilter): StockRow[] {
  const companies = rows.filter((r) => !r.isBenchmark);
  return filter === "all" ? companies : companies.filter((r) => r.category === filter);
}

export function formatPrice(v: number | null | undefined): string {
  if (!isNum(v)) return NA;
  const d = dashboardConfig.display.priceDecimals;
  return v.toLocaleString(dashboardConfig.display.locale, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function signed(v: number, decimals: number): string {
  const rounded = Number(v.toFixed(decimals));
  const body = Math.abs(rounded).toFixed(decimals);
  if (rounded > 0) return `+${body}`;
  if (rounded < 0) return `−${body}`;
  return body;
}

export function formatPercent(v: number | null | undefined): string {
  return isNum(v) ? `${signed(v, dashboardConfig.display.percentDecimals)}%` : NA;
}

export function formatPp(v: number | null | undefined): string {
  return isNum(v) ? `${signed(v, dashboardConfig.display.percentDecimals)} pp` : NA;
}

export function formatMarketCap(v: number | null | undefined): string {
  if (!isNum(v) || v <= 0) return NA;
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (v >= size) return `$${(v / size).toFixed(2)}${suffix}`;
  }
  return `$${v.toFixed(0)}`;
}

export type Trend = "up" | "down" | "flat" | "none";

export function trendOf(v: number | null | undefined): Trend {
  if (!isNum(v)) return "none";
  const rounded = Number(v.toFixed(dashboardConfig.display.percentDecimals));
  return rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
}
