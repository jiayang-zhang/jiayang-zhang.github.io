import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { CATALYST_STATUS_LABELS, CATALYST_TYPE_LABELS, REGISTRY_NOTE, catalystTiming, dateRecentlyChanged, formatCatalystDate } from "../../../shared/catalysts";
import { allCompanies, dashboardConfig } from "../../../shared/config";
import type { Catalyst, CatalystFeed, CatalystStatus, CatalystType } from "../../../shared/types";
import type { Api } from "../api";
import { formatTimestamp } from "../time";
import { ModuleCard } from "./ModuleCard";

type LoadState = { phase: "loading" } | { phase: "error" } | { phase: "ready"; feed: CatalystFeed; refreshFailed: boolean };
type TypeFilter = "all" | CatalystType;

const COMPANIES = new Map(allCompanies().map((c) => [c.ticker, c]));
const FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pdufa", label: "PDUFA" },
  { value: "readout", label: "Readouts" },
  { value: "adcom", label: "AdCom" },
];
// Text symbols accompany the colour so status never depends on colour alone.
const STATUS_ICON: Record<CatalystStatus, string> = { confirmed: "✓", estimated: "≈", unverified: "?" };

export function CatalystItem({ item, today, nowSeconds }: { item: Catalyst; today: string; nowSeconds: number }) {
  const company = COMPANIES.get(item.ticker);
  const timing = catalystTiming(item, today);
  const changed = dateRecentlyChanged(item, nowSeconds);
  const classes = ["bt-cat-item", timing.imminent ? "bt-cat-item--imminent" : "", timing.overdue ? "bt-cat-item--overdue" : ""].join(" ").trim();
  return (
    <li class={classes} data-id={item.id}>
      <div class="bt-cat-when">
        <span class="bt-cat-date">{formatCatalystDate(item)}</span>
        <span class="bt-cat-count">{timing.label}</span>
      </div>
      <div class="bt-cat-main">
        <div class="bt-cat-head">
          {company && <span class={`bt-cat-mark bt-cat--${company.category}`} title={dashboardConfig.categoryLabels[company.category]} aria-hidden="true" />}
          <strong>{item.ticker}</strong>
          <span class="bt-muted">{company?.name ?? ""}</span>
          <span class={`bt-badge bt-type--${item.eventType}`}>{CATALYST_TYPE_LABELS[item.eventType]}</span>
          <span class={`bt-badge bt-status--${item.status}`}>
            <span aria-hidden="true">{STATUS_ICON[item.status]} </span>
            {CATALYST_STATUS_LABELS[item.status]}
          </span>
          {timing.overdue && <span class="bt-tag bt-tag--warn">Overdue</span>}
          {timing.imminent && <span class="bt-tag bt-tag--soon">Within 7 days</span>}
          {changed && (
            <span class="bt-tag bt-tag--warn">Date changed (was {formatCatalystDate({ dateStart: item.previousDateStart!, dateEnd: null })})</span>
          )}
        </div>
        <div class="bt-cat-what">
          {item.program}
          {item.indication && <span class="bt-muted"> — {item.indication}</span>}
          {item.phase && <span class="bt-muted"> ({item.phase})</span>}
        </div>
        <div class="bt-cat-src">
          Source:{" "}
          {item.sourceUrl ? (
            <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
              {item.sourceName ?? "link"}
            </a>
          ) : (
            (item.sourceName ?? "not given")
          )}
          {" · "}Last verified {formatTimestamp(item.lastVerifiedAt)}
          {item.nctId && item.origin === "manual" && (
            <>
              {" · "}
              <a href={`https://clinicaltrials.gov/study/${item.nctId}`} target="_blank" rel="noopener noreferrer">
                {item.nctId}
              </a>
            </>
          )}
          {item.origin === "registry" && item.nctId && <> · {item.nctId}</>}
        </div>
        {item.origin === "registry" && (
          <p class="bt-cat-note">
            Registry date type: {item.registryDateType === "ACTUAL" ? "Actual (already passed)" : item.registryDateType === "ANTICIPATED" ? "Anticipated" : "not stated"}. {REGISTRY_NOTE}
          </p>
        )}
      </div>
    </li>
  );
}

export function CatalystModule({ api }: { api: Api }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [shown, setShown] = useState(dashboardConfig.catalysts.pageSize);

  const load = useCallback(async () => {
    try {
      const feed = await api.catalysts();
      setState({ phase: "ready", feed, refreshFailed: false });
    } catch {
      setState((prev) => (prev.phase === "ready" ? { ...prev, refreshFailed: true } : { phase: "error" }));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, dashboardConfig.refreshIntervals.catalystsMs);
    return () => clearInterval(timer);
  }, [load]);

  const feed = state.phase === "ready" ? state.feed : null;
  const items = useMemo(() => (feed ? feed.items.filter((c) => filter === "all" || c.eventType === filter) : []), [feed, filter]);
  const stale = state.phase === "ready" && (state.refreshFailed || state.feed.lastRefreshFailed);

  return (
    <ModuleCard
      id="bt-catalysts"
      title="Catalyst Calendar"
      meta={
        feed && (
          <>
            <span>Registry last synced: {formatTimestamp(feed.lastSuccessAt)}</span>
            {stale && (
              <span class="bt-tag bt-tag--warn" title="The most recent update did not fully succeed; some entries may be out of date">
                Stale
              </span>
            )}
          </>
        )
      }
    >
      {state.phase === "loading" && (
        <p class="bt-state" role="status">
          Loading catalysts…
        </p>
      )}
      {state.phase === "error" && (
        <div class="bt-state bt-state--error" role="alert">
          <p>The catalyst calendar is unavailable right now.</p>
          <button type="button" class="bt-chip" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {feed && (
        <>
          <p class="bt-session">
            Next {feed.lookAheadDays} days. PDUFA dates and advisory committee meetings are entered by hand and may be incomplete; readouts marked Estimated come from ClinicalTrials.gov.
          </p>
          <div class="bt-filters" role="group" aria-label="Filter catalysts by event type">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" class="bt-chip" aria-pressed={filter === f.value} onClick={() => (setFilter(f.value), setShown(dashboardConfig.catalysts.pageSize))}>
                {f.label}
              </button>
            ))}
            <span class="bt-muted bt-count">
              {items.length} event{items.length === 1 ? "" : "s"}
            </span>
          </div>
          {items.length === 0 ? (
            <p class="bt-state" role="status">
              {feed.items.length === 0 ? `No catalysts in the next ${feed.lookAheadDays} days.` : "No events of this type."}
            </p>
          ) : (
            <>
              <ol class="bt-timeline">
                {items.slice(0, shown).map((item) => (
                  <CatalystItem key={item.id} item={item} today={feed.today} nowSeconds={Math.floor(Date.now() / 1000)} />
                ))}
              </ol>
              {items.length > shown && (
                <button type="button" class="bt-chip bt-more" onClick={() => setShown(shown + dashboardConfig.catalysts.pageSize)}>
                  Show more ({items.length - shown} remaining)
                </button>
              )}
            </>
          )}
        </>
      )}
    </ModuleCard>
  );
}
