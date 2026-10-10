import { useMemo, useState } from "preact/hooks";
import {
  filterCompanies,
  formatMarketCap,
  formatPercent,
  formatPp,
  formatPrice,
  NA,
  sortRows,
  trendOf,
  type CategoryFilter,
  type SortDirection,
  type SortKey,
  type Trend,
} from "../../../shared/calc";
import { dashboardConfig } from "../../../shared/config";
import type { StockRow } from "../../../shared/types";
import { Sparkline } from "./Sparkline";

interface Column {
  key: SortKey;
  label: string;
  /** Full name, used as tooltip and accessible label for abbreviated headers. */
  title: string;
  numeric: boolean;
  secondary?: boolean;
}

const COLUMNS: Column[] = [
  { key: "ticker", label: "Ticker", title: "Ticker symbol (US listing)", numeric: false },
  { key: "name", label: "Company", title: "Company name", numeric: false, secondary: true },
  { key: "category", label: "Cat.", title: "Category", numeric: false, secondary: true },
  { key: "price", label: "Price", title: `Latest available price, ${dashboardConfig.display.currency}`, numeric: true },
  { key: "changePct", label: "Chg %", title: "Daily change: latest price versus previous official close", numeric: true },
  { key: "relativePp", label: "vs Bmk", title: "Daily change minus the category benchmark's daily change, in percentage points", numeric: true },
  { key: "marketCap", label: "Mkt Cap", title: `Market capitalisation, ${dashboardConfig.display.currency}`, numeric: true, secondary: true },
];

const FILTERS: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pharma", label: dashboardConfig.categoryLabels.pharma },
  { value: "biotech", label: dashboardConfig.categoryLabels.biotech },
];

const TREND_GLYPH: Record<Trend, string> = { up: "▲", down: "▼", flat: "", none: "" };

function Change({ value, text }: { value: number | null; text: string }) {
  const trend = trendOf(value);
  return (
    <span class={`bt-trend--${trend}`}>
      {TREND_GLYPH[trend] && <span aria-hidden="true">{TREND_GLYPH[trend]} </span>}
      {text}
    </span>
  );
}

function Row({ row }: { row: StockRow }) {
  const label = dashboardConfig.categoryLabels[row.category];
  return (
    <tr class={row.isBenchmark ? "bt-row bt-row--benchmark" : "bt-row"} data-ticker={row.ticker}>
      <th scope="row" class="bt-cell-ticker">
        <span class={`bt-cat-mark bt-cat--${row.category}`} title={label} aria-hidden="true" />
        {row.ticker}
        <span class="bt-sr"> ({label})</span>
        {row.isBenchmark && <span class="bt-tag">Benchmark</span>}
        {row.stale && (
          <span class="bt-tag bt-tag--warn" title="This quote is older than expected">
            Stale
          </span>
        )}
      </th>
      <td class="bt-secondary">{row.name}</td>
      <td class="bt-secondary">
        <span class={`bt-cat-label bt-cat--${row.category}`}>{label}</span>
      </td>
      <td class="bt-num">{formatPrice(row.price)}</td>
      <td class="bt-num">
        <Change value={row.changePct} text={formatPercent(row.changePct)} />
      </td>
      <td class="bt-num" title={row.isBenchmark ? "Benchmarks are not compared with themselves" : `Relative to ${row.benchmarkTicker}`}>
        {row.isBenchmark ? <span class="bt-muted">{"—"}</span> : <Change value={row.relativePp} text={formatPp(row.relativePp)} />}
      </td>
      <td class="bt-cell-spark">
        <Sparkline points={row.sparkline} ticker={row.ticker} />
      </td>
      <td class="bt-num bt-secondary">{row.isBenchmark ? <span class="bt-muted" title="Not applicable to ETFs">{NA}</span> : formatMarketCap(row.marketCap)}</td>
    </tr>
  );
}

export function StockTable({ benchmarks, companies }: { benchmarks: StockRow[]; companies: StockRow[] }) {
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({ key: "ticker", dir: "asc" });

  const rows = useMemo(() => sortRows(filterCompanies(companies, filter), sort.key, sort.dir), [companies, filter, sort]);

  const toggleSort = (key: SortKey, numeric: boolean) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: numeric ? "desc" : "asc" }));

  return (
    <div>
      <div class="bt-filters" role="group" aria-label="Filter companies by category">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" class="bt-chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.value !== "all" && <span class={`bt-cat-mark bt-cat--${f.value}`} aria-hidden="true" />}
            {f.label}
          </button>
        ))}
        <span class="bt-muted bt-count">
          {rows.length} of {companies.length} companies
        </span>
      </div>

      <div class="bt-scroll" tabIndex={0} role="region" aria-label="Stock performance table">
        <table class="bt-table">
          <thead>
            <tr>
              {COLUMNS.slice(0, 6).map((col) => (
                <HeaderCell key={col.key} col={col} sort={sort} onSort={toggleSort} />
              ))}
              <th scope="col" title="Daily closes over the last five trading days">
                5D
              </th>
              <HeaderCell col={COLUMNS[6]!} sort={sort} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody class="bt-benchmarks">
            {benchmarks.map((row) => (
              <Row key={row.ticker} row={row} />
            ))}
          </tbody>
          <tbody>
            {rows.map((row) => (
              <Row key={row.ticker} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeaderCell({ col, sort, onSort }: { col: Column; sort: { key: SortKey; dir: SortDirection }; onSort: (key: SortKey, numeric: boolean) => void }) {
  const active = sort.key === col.key;
  const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={ariaSort} class={[col.numeric ? "bt-num" : "", col.secondary ? "bt-secondary" : ""].join(" ").trim()}>
      <button type="button" class="bt-sort" title={col.title} aria-label={`${col.title}. Sort ${active && sort.dir === "asc" ? "descending" : "ascending"}`} onClick={() => onSort(col.key, col.numeric)}>
        {col.label}
        <span class="bt-sort__icon" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}
