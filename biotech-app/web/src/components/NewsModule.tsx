import { useCallback, useEffect, useState } from "preact/hooks";
import { allCompanies, dashboardConfig } from "../../../shared/config";
import { formatCatalystDate } from "../../../shared/catalysts";
import { EVENT_CATEGORIES, EVENT_CATEGORY_LABELS, EVENT_TONES, EVIDENCE_LABELS, TRIAL_PHASE_LABELS, type ClinicalEvent, type ClinicalFeed, type EventCategory, type EventTone } from "../../../shared/events";
import type { Api } from "../api";
import { formatTimestamp } from "../time";
import { ModuleCard } from "./ModuleCard";

type LoadState = { phase: "loading" } | { phase: "error" } | { phase: "ready"; feed: ClinicalFeed; items: ClinicalEvent[]; refreshFailed: boolean; loadingMore: boolean };

const COMPANIES = new Map(allCompanies().map((c) => [c.ticker, c]));
// Symbols accompany the colours so outcome and status never depend on colour alone.
const TONE_ICON: Record<EventTone, string> = { success: "✓", failure: "✕", initiation: "▶" };
const day = (date: string) => formatCatalystDate({ dateStart: date, dateEnd: null });

export function EventCard({ event }: { event: ClinicalEvent }) {
  const company = COMPANIES.get(event.ticker);
  const tone = EVENT_TONES[event.category];
  const others = event.sources.filter((s) => s.url !== event.primarySource?.url);
  return (
    <li class={`bt-event bt-event--${tone}`} data-id={event.id}>
      <div class="bt-cat-head">
        <span class="bt-cat-date">{day(event.announcementDate)}</span>
        {company && <span class={`bt-cat-mark bt-cat--${company.category}`} title={dashboardConfig.categoryLabels[company.category]} aria-hidden="true" />}
        <strong>{event.ticker}</strong>
        <span class="bt-muted">{company?.name ?? ""}</span>
        {company && <span class="bt-sr"> ({dashboardConfig.categoryLabels[company.category]})</span>}
        <span class={`bt-badge bt-tone--${tone}`}>
          <span aria-hidden="true">{TONE_ICON[tone]} </span>
          {EVENT_CATEGORY_LABELS[event.category]}
        </span>
        {event.verification === "verified" ? (
          <span class="bt-badge bt-status--confirmed">
            <span aria-hidden="true">{"✓"} </span>Verified
          </span>
        ) : (
          <span class="bt-tag bt-tag--warn" title="Classified automatically; not yet confirmed by a person">
            Unreviewed
          </span>
        )}
      </div>
      <div class="bt-cat-what">
        {event.program}
        {event.indication && <span class="bt-muted"> — {event.indication}</span>}
        {event.phase && <span class="bt-muted"> ({TRIAL_PHASE_LABELS[event.phase]})</span>}
      </div>
      <p class="bt-event__summary">{event.summary}</p>
      <div class="bt-cat-src">
        Evidence: <strong>{EVIDENCE_LABELS[event.evidenceBasis]}</strong>
        {event.eventDate && <> · Event date {day(event.eventDate)}</>}
        {" · "}Source:{" "}
        {event.primarySource ? (
          <a href={event.primarySource.url} target="_blank" rel="noopener noreferrer">
            {event.primarySource.label}
          </a>
        ) : (
          "not available"
        )}
        {others.map((s, i) => (
          <span key={s.url}>
            {i === 0 ? " · Also: " : ", "}
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.label}
            </a>
          </span>
        ))}
        {event.nctId && (
          <>
            {" · "}Trial:{" "}
            <a href={`https://clinicaltrials.gov/study/${event.nctId}`} target="_blank" rel="noopener noreferrer">
              {event.nctId}
            </a>
          </>
        )}
        {" · "}Retrieved {formatTimestamp(event.lastRetrievedAt)}
      </div>
    </li>
  );
}

export function NewsModule({ api }: { api: Api }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [category, setCategory] = useState<EventCategory | null>(null);

  const load = useCallback(
    async (selected: EventCategory | null) => {
      try {
        const feed = await api.events(selected, 0);
        setState({ phase: "ready", feed, items: feed.items, refreshFailed: false, loadingMore: false });
      } catch {
        setState((prev) => (prev.phase === "ready" ? { ...prev, refreshFailed: true } : { phase: "error" }));
      }
    },
    [api],
  );

  useEffect(() => {
    void load(category);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(category);
    }, dashboardConfig.refreshIntervals.newsMs);
    return () => clearInterval(timer);
  }, [load, category]);

  const loadMore = async () => {
    if (state.phase !== "ready" || state.feed.nextOffset === null) return;
    setState({ ...state, loadingMore: true });
    try {
      const next = await api.events(category, state.feed.nextOffset);
      const seen = new Set(state.items.map((e) => e.id));
      setState({ phase: "ready", feed: next, items: [...state.items, ...next.items.filter((e) => !seen.has(e.id))], refreshFailed: false, loadingMore: false });
    } catch {
      setState({ ...state, refreshFailed: true, loadingMore: false });
    }
  };

  const ready = state.phase === "ready" ? state : null;
  const stale = ready !== null && (ready.refreshFailed || ready.feed.lastRefreshFailed);

  return (
    <ModuleCard
      id="bt-news"
      title="Clinical Trial Feed"
      meta={
        ready && (
          <>
            <span>Last successful update: {formatTimestamp(ready.feed.lastSuccessAt)}</span>
            {stale && (
              <span class="bt-tag bt-tag--warn" title="The most recent update did not fully succeed; the feed may be missing recent events">
                Stale
              </span>
            )}
          </>
        )
      }
    >
      {state.phase === "loading" && (
        <p class="bt-state" role="status">
          Loading clinical events…
        </p>
      )}
      {state.phase === "error" && (
        <div class="bt-state bt-state--error" role="alert">
          <p>The clinical trial feed is unavailable right now.</p>
          <button type="button" class="bt-chip" onClick={() => void load(category)}>
            Retry
          </button>
        </div>
      )}
      {ready && (
        <>
          <p class="bt-session">
            Phase II and III results and Phase III starts for watchlist companies, from SEC filings and ClinicalTrials.gov. Coverage is not exhaustive.
            {ready.feed.showsUnreviewed && " Events marked Unreviewed were classified automatically and have not been confirmed."}
          </p>
          <div class="bt-filters" role="group" aria-label="Filter events by category">
            <button type="button" class="bt-chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
              All
            </button>
            {EVENT_CATEGORIES.map((c) => (
              <button key={c} type="button" class="bt-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                <span class={`bt-tone--${EVENT_TONES[c]}`} aria-hidden="true">
                  {TONE_ICON[EVENT_TONES[c]]}
                </span>
                {EVENT_CATEGORY_LABELS[c]}
              </button>
            ))}
            <span class="bt-muted bt-count">
              {ready.items.length} of {ready.feed.total} events
            </span>
          </div>
          {ready.items.length === 0 ? (
            <p class="bt-state" role="status">
              {category ? "No events in this category." : "No clinical events recorded yet."}
            </p>
          ) : (
            <>
              <ol class="bt-timeline">
                {ready.items.map((event) => (
                  <EventCard key={event.id} event={event} />
                ))}
              </ol>
              {ready.feed.nextOffset !== null && (
                <button type="button" class="bt-chip bt-more" disabled={ready.loadingMore} onClick={() => void loadMore()}>
                  {ready.loadingMore ? "Loading…" : `Load more (${ready.feed.total - ready.items.length} remaining)`}
                </button>
              )}
            </>
          )}
        </>
      )}
    </ModuleCard>
  );
}
