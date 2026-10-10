import { useCallback, useEffect, useState } from "preact/hooks";
import { allCompanies } from "../../../shared/config";
import { EVENT_CATEGORIES, EVENT_CATEGORY_LABELS, EVIDENCE_BASES, EVIDENCE_LABELS, TRIAL_PHASES, TRIAL_PHASE_LABELS, isIsoDate, type ReviewInput, type ReviewItem, type ReviewStatus } from "../../../shared/events";
import { ApiError, type Api, type ClinicalStatus, type RefreshResult } from "../api";

type Form = Record<keyof ReviewInput, string>;
const COMPANIES = new Map(allCompanies().map((c) => [c.ticker, c]));
const TABS: Array<{ value: ReviewStatus; label: string }> = [
  { value: "pending", label: "Pending review" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
];

const toForm = (i: ReviewItem): Form => ({
  category: i.category ?? "", phase: i.phase ?? "", program: i.program ?? "", indication: i.indication ?? "", summary: i.summary ?? "",
  evidenceBasis: i.evidenceBasis ?? "", nctId: i.nctId ?? "", announcementDate: i.announcementDate, eventDate: i.eventDate ?? "",
});

export function validateReview(f: Form): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!f.category) errors.category = "Required";
  if (!f.program.trim()) errors.program = "Required";
  if (!f.summary.trim()) errors.summary = "Required";
  if (!f.evidenceBasis) errors.evidenceBasis = "Required";
  if (!isIsoDate(f.announcementDate)) errors.announcementDate = "Use a real date in YYYY-MM-DD format";
  if (f.eventDate && !isIsoDate(f.eventDate)) errors.eventDate = "Use a real date in YYYY-MM-DD format";
  if (f.nctId && !/^NCT\d{8}$/.test(f.nctId.trim())) errors.nctId = "Format: NCT followed by 8 digits";
  return errors;
}

function ReviewCard({ item, api, onDone }: { item: ReviewItem; api: Api; onDone: (message: string) => void }) {
  const [form, setForm] = useState<Form>(toForm(item));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fid = (name: string) => `bt-r-${item.id}-${name}`;
  const set = (key: keyof Form) => (e: Event) => setForm({ ...form, [key]: (e.target as HTMLInputElement).value });
  const describe = (name: string) => (errors[name] ? { "aria-invalid": true, "aria-describedby": `${fid(name)}-error` } : {});
  const label = `${item.ticker} ${item.program ?? "candidate"}`;

  const act = async (action: "confirm" | "save" | "reject") => {
    setMessage(null);
    if (action !== "reject") {
      const found = validateReview(form);
      setErrors(found);
      if (Object.keys(found).length > 0) return;
    }
    setBusy(true);
    try {
      const input = form as unknown as ReviewInput;
      if (action === "confirm") await api.confirmReview(item.id, input);
      else if (action === "save") await api.saveReview(item.id, input);
      else await api.rejectReview(item.id);
      onDone(action === "confirm" ? `${label}: verified.` : action === "save" ? `${label}: changes saved, still pending.` : `${label}: rejected.`);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      const status = err instanceof ApiError ? err.status : null;
      setMessage(status === 401 ? "Session expired. Sign in again." : status === 400 ? "Please correct the highlighted fields." : "Action failed. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  const field = (name: keyof Form, text: string, control: preact.ComponentChildren) => (
    <div class="bt-field">
      <label for={fid(name)}>{text}</label>
      {control}
      {errors[name] && (
        <span class="bt-field__error" id={`${fid(name)}-error`} role="alert">
          {errors[name]}
        </span>
      )}
    </div>
  );

  return (
    <li class="bt-review" data-id={item.id}>
      <div class="bt-cat-head">
        <strong>{item.ticker}</strong>
        <span class="bt-muted">{COMPANIES.get(item.ticker)?.name ?? ""}</span>
        <span class="bt-badge">{item.category ? EVENT_CATEGORY_LABELS[item.category] : "Uncategorised"}</span>
        <span class="bt-tag">{item.origin === "llm" ? `Classified by ${item.model ?? "model"}` : item.origin === "registry" ? "Registry signal" : "Manual candidate"}</span>
        {item.truncated && (
          <span class="bt-tag bt-tag--warn" title="The source was longer than the classifier's input limit; read the full source before confirming">
            Source truncated
          </span>
        )}
      </div>
      {item.note && <p class="bt-review__note">Note: {item.note}</p>}
      {item.excerpt && <blockquote class="bt-review__excerpt">{item.excerpt}</blockquote>}
      <p class="bt-cat-src">
        Sources:{" "}
        {item.sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 && ", "}
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.label}
              {s.date ? ` (${s.date})` : ""}
            </a>
          </span>
        ))}
        {item.promptVersion && <> · Prompt {item.promptVersion}</>}
      </p>
      <form class="bt-form" onSubmit={(e) => (e.preventDefault(), void act("confirm"))} noValidate aria-label={`Review ${label}`}>
        {field("category", "Category *",
          <select id={fid("category")} value={form.category} onChange={set("category")} {...describe("category")}>
            <option value="">Select…</option>
            {EVENT_CATEGORIES.map((c) => <option key={c} value={c}>{EVENT_CATEGORY_LABELS[c]}</option>)}
          </select>,
        )}
        {field("evidenceBasis", "Evidence basis *",
          <select id={fid("evidenceBasis")} value={form.evidenceBasis} onChange={set("evidenceBasis")} {...describe("evidenceBasis")}>
            <option value="">Select…</option>
            {EVIDENCE_BASES.map((b) => <option key={b} value={b}>{EVIDENCE_LABELS[b]}</option>)}
          </select>,
        )}
        {field("phase", "Trial phase",
          <select id={fid("phase")} value={form.phase} onChange={set("phase")} {...describe("phase")}>
            <option value="">Not stated</option>
            {TRIAL_PHASES.map((p) => <option key={p} value={p}>{TRIAL_PHASE_LABELS[p]}</option>)}
          </select>,
        )}
        {field("program", "Drug or programme *", <input id={fid("program")} type="text" maxLength={200} value={form.program} onInput={set("program")} {...describe("program")} />)}
        {field("indication", "Indication", <input id={fid("indication")} type="text" maxLength={300} value={form.indication} onInput={set("indication")} {...describe("indication")} />)}
        {field("nctId", "NCT number", <input id={fid("nctId")} type="text" value={form.nctId} onInput={set("nctId")} {...describe("nctId")} />)}
        {field("announcementDate", "Announcement date *", <input id={fid("announcementDate")} type="date" value={form.announcementDate} onInput={set("announcementDate")} {...describe("announcementDate")} />)}
        {field("eventDate", "Event date (if different)", <input id={fid("eventDate")} type="date" value={form.eventDate} onInput={set("eventDate")} {...describe("eventDate")} />)}
        <div class="bt-field bt-field--wide">
          <label for={fid("summary")}>One-sentence summary *</label>
          <textarea id={fid("summary")} rows={2} maxLength={600} value={form.summary} onInput={set("summary")} {...describe("summary")} />
          {errors.summary && (
            <span class="bt-field__error" id={`${fid("summary")}-error`} role="alert">
              {errors.summary}
            </span>
          )}
        </div>
        <div class="bt-form__actions">
          <button type="submit" class="bt-chip bt-chip--primary" disabled={busy} aria-label={`Confirm ${label} as verified`}>
            {item.status === "verified" ? "Save (stays verified)" : "Confirm as verified"}
          </button>
          {item.status === "pending" && (
            <button type="button" class="bt-chip" disabled={busy} aria-label={`Save edits to ${label}`} onClick={() => void act("save")}>
              Save edits
            </button>
          )}
          {item.status !== "rejected" && (
            <button type="button" class="bt-chip" disabled={busy} aria-label={`Reject ${label}`} onClick={() => void act("reject")}>
              Reject
            </button>
          )}
          <span role="status">{message}</span>
        </div>
      </form>
    </li>
  );
}

function IngestButton({ label, run, onDone }: { label: string; run: () => Promise<RefreshResult>; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const onClick = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await run();
      setMessage(`${r.updated} handled${r.failed.length ? `, ${r.failed.length} failed` : ""}${r.backlog !== undefined ? `, ${r.backlog} waiting` : ""}.`);
      onDone();
    } catch (err) {
      setMessage(err instanceof ApiError && err.status === 401 ? "Session expired. Sign in again." : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="bt-admin-action">
      <button type="button" class="bt-chip" disabled={busy} onClick={() => void onClick()}>
        {busy ? "Working…" : label}
      </button>
      <span role="status">{message}</span>
    </div>
  );
}

export function ReviewQueue({ api }: { api: Api }) {
  const [tab, setTab] = useState<ReviewStatus>("pending");
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [status, setStatus] = useState<ClinicalStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (which: ReviewStatus) => {
      try {
        const [queue, s] = await Promise.all([api.reviewQueue(which), api.clinicalStatus()]);
        setItems(queue.items);
        setStatus(s);
        setLoadFailed(false);
      } catch {
        setLoadFailed(true);
      }
    },
    [api],
  );

  useEffect(() => void load(tab), [load, tab]);

  const docs = status?.documents ?? {};
  const waiting = (docs.discovered ?? 0) + (docs.fetched ?? 0);

  return (
    <div class="bt-admin-section">
      <h3 class="bt-subhead">Clinical feed</h3>
      {status && (
        <p class="bt-muted">
          Mode: {status.mode}. {waiting} documents waiting, {docs.classified ?? 0} classified, {docs.excluded ?? 0} excluded, {docs.error ?? 0} failed. Classifier {status.model}: {status.inputTokens.toLocaleString()} input and{" "}
          {status.outputTokens.toLocaleString()} output tokens used so far.
        </p>
      )}
      {status && status.mode === "llm-with-review" && !status.classifierConfigured && (
        <p class="bt-banner" role="note">
          No classifier key is configured. Filings are collected but not classified until the Anthropic API key is added as a Worker secret (see README).
        </p>
      )}
      <IngestButton label="Look for new filings" run={() => api.refreshClinical("discover")} onDone={() => void load(tab)} />
      <IngestButton label="Process next batch" run={() => api.refreshClinical("process")} onDone={() => void load(tab)} />
      <IngestButton label="Check registry status changes" run={api.refreshSignals} onDone={() => void load(tab)} />

      <div class="bt-filters" role="group" aria-label="Review queue status">
        {TABS.map((t) => (
          <button key={t.value} type="button" class="bt-chip" aria-pressed={tab === t.value} onClick={() => (setItems(null), setMessage(null), setTab(t.value))}>
            {t.label}
            {status ? ` (${status.events[t.value] ?? 0})` : ""}
          </button>
        ))}
      </div>
      <p role="status">{message}</p>
      {loadFailed && (
        <p class="bt-state bt-state--error" role="alert">
          Could not load the review queue.
        </p>
      )}
      {items && items.length === 0 && <p class="bt-muted">Nothing here.</p>}
      {items && items.length > 0 && (
        <ul class="bt-timeline">
          {items.map((item) => (
            <ReviewCard key={`${item.id}:${item.status}`} item={item} api={api} onDone={(m) => (setMessage(m), void load(tab))} />
          ))}
        </ul>
      )}
    </div>
  );
}
