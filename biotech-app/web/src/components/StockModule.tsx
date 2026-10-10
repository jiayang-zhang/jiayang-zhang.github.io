import { useCallback, useEffect, useState } from "preact/hooks";
import { dashboardConfig } from "../../../shared/config";
import type { MarketSnapshot } from "../../../shared/types";
import type { Api } from "../api";
import { formatTimestamp } from "../time";
import { ModuleCard } from "./ModuleCard";
import { StockTable } from "./StockTable";

type LoadState = { phase: "loading" } | { phase: "error" } | { phase: "ready"; snapshot: MarketSnapshot; refreshFailed: boolean };

export function StockModule({ api }: { api: Api }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(async () => {
    try {
      const snapshot = await api.market();
      setState({ phase: "ready", snapshot, refreshFailed: false });
    } catch {
      // Keep showing the last good data, flagged, rather than blanking the table.
      setState((prev) => (prev.phase === "ready" ? { ...prev, refreshFailed: true } : { phase: "error" }));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, dashboardConfig.refreshIntervals.pricesMs);
    return () => clearInterval(timer);
  }, [load]);

  const snapshot = state.phase === "ready" ? state.snapshot : null;
  const hasPrices = snapshot ? [...snapshot.benchmarks, ...snapshot.companies].some((r) => r.price !== null) : false;
  const stale = state.phase === "ready" && (state.refreshFailed || state.snapshot.lastRefreshFailed);

  return (
    <ModuleCard
      id="bt-stocks"
      title="Stock Performance"
      meta={
        snapshot && (
          <>
            <span>Last successful update: {formatTimestamp(snapshot.lastSuccessAt)}</span>
            {stale && (
              <span class="bt-tag bt-tag--warn" title="The most recent refresh did not fully succeed; some values may be out of date">
                Stale
              </span>
            )}
          </>
        )
      }
    >
      {state.phase === "loading" && (
        <p class="bt-state" role="status">
          Loading market data…
        </p>
      )}

      {state.phase === "error" && (
        <div class="bt-state bt-state--error" role="alert">
          <p>Market data is unavailable right now.</p>
          <button type="button" class="bt-chip" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {snapshot && snapshot.source === "mock" && (
        <p class="bt-banner" role="note">
          <strong>MOCK DATA</strong> — these prices are generated placeholders, not market data.
        </p>
      )}

      {snapshot && !hasPrices && (
        <p class="bt-state" role="status">
          No market data has been collected yet.
        </p>
      )}

      {snapshot && hasPrices && (
        <>
          <p class="bt-session">
            {snapshot.marketOpen ? (
              <>
                <span class="bt-dot bt-dot--open" aria-hidden="true" /> Market open. Price is the latest available; change is measured against the previous official close.
              </>
            ) : (
              <>
                <span class="bt-dot" aria-hidden="true" /> Market closed. Showing the latest available price, not a new trade.
              </>
            )}
          </p>
          <StockTable benchmarks={snapshot.benchmarks} companies={snapshot.companies} />
        </>
      )}
    </ModuleCard>
  );
}
