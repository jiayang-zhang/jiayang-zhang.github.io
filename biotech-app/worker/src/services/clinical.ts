import { z } from "zod";
import { addDays, daysBetween, utcDate } from "../../../shared/catalysts";
import { allCompanies, dashboardConfig } from "../../../shared/config";
import {
  EVENT_CATEGORIES,
  EVIDENCE_BASES,
  SOURCE_AUTHORITY,
  SOURCE_KIND_LABELS,
  TRIAL_PHASES,
  isIsoDate,
  normaliseName,
  publicVerification,
  type ClinicalEvent,
  type ClinicalFeed,
  type EventCategory,
  type EventSource,
  type EvidenceBasis,
  type ReviewInput,
  type ReviewItem,
  type ReviewStatus,
  type SourceKind,
  type TerminationReason,
  type TrialPhase,
} from "../../../shared/events";
import type { WatchlistCompany } from "../../../shared/types";
import { prefilterFilingMetadata, prefilterText } from "../clinical/prefilter";
import { classificationSchema, evaluateClassification, registrySignal, type EventDraft } from "../clinical/rules";
import { truncate } from "../clinical/text";
import { getJobStatus, recordJobRun } from "../db";
import { mapLimit, UpstreamError } from "../lib/http";
import type { Classifier } from "../providers/classifier";
import type { TrialStatusProvider } from "../providers/clinicaltrials";
import { filingUrl, type EdgarProvider } from "../providers/edgar";
import type { NewsProvider } from "../providers/rss";

const JOB = "clinical";
const SIGNALS_JOB = "signals";
// Outbound requests one scheduled run may spend on documents: a stored
// document costs one (the classifier), a new filing up to four.
const COST_FETCHED = 1;
const COST_DISCOVERED = 4;

export interface ClinicalDeps {
  edgar: EdgarProvider;
  classifier: Classifier | null;
  news?: NewsProvider;
}

interface DocumentRow {
  id: string;
  source: SourceKind;
  ticker: string;
  form: string | null;
  accession: string | null;
  primary_document: string | null;
  items: string | null;
  title: string | null;
  url: string;
  published_date: string;
  state: "discovered" | "fetched" | "classified" | "unclassified" | "excluded" | "error";
  state_reason: string | null;
  body: string | null;
  truncated: number;
  attempts: number;
}

interface EventRow {
  id: string;
  ticker: string;
  category: EventCategory | null;
  phase: TrialPhase | null;
  program: string | null;
  program_key: string | null;
  indication: string | null;
  summary: string | null;
  evidence_basis: EvidenceBasis | null;
  nct_id: string | null;
  announcement_date: string;
  event_date: string | null;
  status: ReviewStatus;
  excerpt: string | null;
  note: string | null;
  termination_reason: TerminationReason | null;
  origin: "llm" | "manual" | "registry";
  model: string | null;
  prompt_version: string | null;
  truncated: number;
  last_retrieved_at: number;
  reviewed_at: number | null;
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const company = (ticker: string): WatchlistCompany | undefined => allCompanies().find((c) => c.ticker === ticker);

async function stableId(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `${prefix}_${[...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function errorKind(err: unknown): string {
  return err instanceof UpstreamError ? err.kind : "error";
}

// ---- Discovery ----

function backfillStart(now: Date): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - dashboardConfig.news.backfillMonths);
  return utcDate(d);
}

const INSERT_DOCUMENT = `INSERT OR IGNORE INTO documents (id, source, ticker, form, accession, primary_document, items, title, url, published_date, state, state_reason, body, truncated, retrieved_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Lists each company's disclosure filings and records the new ones. On the
 * first run this covers the whole backfill window; afterwards only filings
 * not seen before are added. Filings ruled out by their metadata are stored
 * as excluded so they are never downloaded.
 */
export async function discoverDocuments(db: D1Database, deps: ClinicalDeps, now: Date = new Date()): Promise<{ added: number; failed: string[]; reasons: string[] }> {
  const nowS = seconds(now);
  const since = backfillStart(now);
  const companies = allCompanies();
  const results = await mapLimit(companies, 2, (c) => deps.edgar.listFilings(c, since));

  const statements: D1PreparedStatement[] = [];
  const failed: string[] = [];
  const reasons: string[] = [];
  results.forEach((r, i) => {
    const c = companies[i]!;
    if (r.status === "rejected") {
      failed.push(c.ticker);
      reasons.push(errorKind(r.reason));
      return;
    }
    for (const f of r.value) {
      const verdict = prefilterFilingMetadata(f.form, f.items, f.description);
      statements.push(
        db
          .prepare(INSERT_DOCUMENT)
          .bind(`edgar:${f.accession}`, "edgar", f.ticker, f.form, f.accession, f.primaryDocument, f.items || null, f.description || f.form, filingUrl(f.cik, f.accession), f.filingDate, verdict.pass ? "discovered" : "excluded", verdict.pass ? null : verdict.reason, null, 0, null, nowS),
      );
    }
  });

  for (const feed of dashboardConfig.news.rssFeeds) {
    if (!deps.news) break;
    try {
      for (const item of await deps.news.fetchFeed(feed.url)) {
        if (!item.date || item.date < since) continue;
        const verdict = prefilterText(item.text);
        const body = truncate(item.text, dashboardConfig.clinical.maxInputChars);
        statements.push(
          db
            .prepare(INSERT_DOCUMENT)
            .bind(await stableId("news", item.link), "news", feed.ticker, null, null, null, null, item.title.slice(0, 300), item.link, item.date, verdict.pass ? "fetched" : "excluded", verdict.pass ? null : verdict.reason, verdict.pass ? body.text : null, body.truncated ? 1 : 0, nowS, nowS),
        );
      }
    } catch (err) {
      failed.push(`${feed.ticker} feed`);
      reasons.push(errorKind(err));
    }
  }

  let added = 0;
  for (let i = 0; i < statements.length; i += 50) {
    const out = await db.batch(statements.slice(i, i + 50));
    added += out.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  return { added, failed, reasons };
}

// ---- Events ----

async function addSource(db: D1Database, eventId: string, doc: Pick<DocumentRow, "id" | "source" | "url" | "form" | "published_date">): Promise<void> {
  const label = doc.source === "edgar" && doc.form ? `SEC Form ${doc.form}` : SOURCE_KIND_LABELS[doc.source];
  await db.prepare("INSERT OR IGNORE INTO event_sources (event_id, document_id, kind, url, label, date) VALUES (?, ?, ?, ?, ?, ?)").bind(eventId, doc.id, doc.source, doc.url, label, doc.published_date).run();
}

function isSameEvent(existing: EventRow, draft: EventDraft, announcementDate: string): boolean {
  if (existing.nct_id && draft.nctId) return existing.nct_id === draft.nctId;
  const key = normaliseName(draft.program);
  if (!key || existing.program_key !== key) return false;
  const close = Math.abs(daysBetween(existing.announcement_date, announcementDate)) <= dashboardConfig.clinical.duplicateWindowDays;
  const sameIndication = normaliseName(existing.indication) !== "" && normaliseName(existing.indication) === normaliseName(draft.indication);
  return close || sameIndication;
}

interface Provenance {
  origin: EventRow["origin"];
  model: string | null;
  truncated: boolean;
}

/**
 * Stores an event, or attaches the document to an event already recorded for
 * the same trial and outcome. A second report of a known result (the press
 * release behind an 8-K, a later article) therefore adds a source link but
 * never a second event, and never changes the review status.
 */
export async function saveEvent(db: D1Database, doc: DocumentRow, draft: EventDraft, provenance: Provenance, now: Date, index = 0): Promise<{ id: string; merged: boolean }> {
  const nowS = seconds(now);
  if (draft.category) {
    const candidates = (await db.prepare("SELECT * FROM events WHERE ticker = ? AND category = ?").bind(doc.ticker, draft.category).all<EventRow>()).results;
    const existing = candidates.find((e) => isSameEvent(e, draft, doc.published_date));
    if (existing) {
      await addSource(db, existing.id, doc);
      await db
        .prepare("UPDATE events SET announcement_date = MIN(announcement_date, ?), nct_id = COALESCE(nct_id, ?), last_retrieved_at = ?, updated_at = ? WHERE id = ?")
        .bind(doc.published_date, draft.nctId, nowS, nowS, existing.id)
        .run();
      return { id: existing.id, merged: true };
    }
  }

  const id = await stableId("evt", `${doc.ticker}|${draft.category ?? "review"}|${draft.nctId ?? normaliseName(draft.program)}|${doc.id}|${index}`);
  await db
    .prepare(
      `INSERT OR IGNORE INTO events (id, ticker, category, phase, program, program_key, indication, summary, evidence_basis, nct_id, announcement_date, event_date,
         status, excerpt, note, termination_reason, origin, model, prompt_version, truncated, last_retrieved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, doc.ticker, draft.category, draft.phase, draft.program, normaliseName(draft.program), draft.indication, draft.summary, draft.evidenceBasis, draft.nctId,
      doc.published_date, draft.eventDate && draft.eventDate !== doc.published_date ? draft.eventDate : null, draft.excerpt, draft.note, draft.terminationReason,
      provenance.origin, provenance.model, provenance.model ? dashboardConfig.clinical.promptVersion : null, provenance.truncated ? 1 : 0, nowS, nowS, nowS,
    )
    .run();
  await addSource(db, id, doc);
  return { id, merged: false };
}

const blankDraft = (note: string, excerpt: string | null): EventDraft => ({ category: null, phase: null, program: null, indication: null, nctId: null, evidenceBasis: null, terminationReason: null, summary: null, excerpt, eventDate: null, note });

function snippet(text: string): string {
  const at = text.search(/top-?line|primary end-?point|phase\s*(2|3|ii|iii)\b/i);
  const start = Math.max(0, at - 200);
  return text.slice(start, start + 700).trim();
}

async function setDocumentState(db: D1Database, id: string, state: DocumentRow["state"], reason: string | null): Promise<void> {
  await db.prepare("UPDATE documents SET state = ?, state_reason = ? WHERE id = ?").bind(state, reason?.slice(0, 500) ?? null, id).run();
}

/** Puts a document in the review queue uncategorised, for a person to categorise. */
async function queueForManualReview(db: D1Database, doc: DocumentRow, note: string, now: Date): Promise<void> {
  await saveEvent(db, doc, blankDraft(note, doc.body ? snippet(doc.body) : null), { origin: "manual", model: null, truncated: doc.truncated === 1 }, now);
  await setDocumentState(db, doc.id, "unclassified", note);
}

type DocumentOutcome = "classified" | "queued" | "excluded" | "retry" | "error";

/** Runs the classifier on a stored document exactly once and records what came of it. */
export async function classifyDocument(db: D1Database, doc: DocumentRow, classifier: Classifier, now: Date = new Date()): Promise<DocumentOutcome> {
  const c = company(doc.ticker);
  if (!c || !doc.body) {
    await setDocumentState(db, doc.id, "error", "Document has no stored text");
    return "error";
  }

  let result;
  try {
    result = await classifier.classify({
      ticker: c.ticker,
      companyName: c.name,
      aliases: c.aliases,
      sourceLabel: doc.source === "edgar" ? `SEC Form ${doc.form}` : SOURCE_KIND_LABELS[doc.source],
      publishedDate: doc.published_date,
      text: doc.body,
    });
  } catch (err) {
    // No answer was produced, so trying again later does not classify the document twice.
    const attempts = doc.attempts + 1;
    const giveUp = attempts >= dashboardConfig.clinical.maxAttempts;
    await db.prepare("UPDATE documents SET attempts = ?, state = ?, state_reason = ? WHERE id = ?").bind(attempts, giveUp ? "error" : "fetched", `Classifier request failed (${errorKind(err)})`, doc.id).run();
    return giveUp ? "error" : "retry";
  }

  await db
    .prepare("UPDATE documents SET model = ?, prompt_version = ?, input_tokens = ?, output_tokens = ?, classified_at = ? WHERE id = ?")
    .bind(result.model, dashboardConfig.clinical.promptVersion, result.inputTokens, result.outputTokens, seconds(now), doc.id)
    .run();

  const parsed = classificationSchema.safeParse(result.output);
  if (!parsed.success) {
    await queueForManualReview(db, doc, "Classifier output failed schema validation; categorise manually", now);
    return "queued";
  }

  const provenance: Provenance = { origin: "llm", model: result.model, truncated: doc.truncated === 1 };
  const notes: string[] = [];
  let created = 0;
  let rejected = 0;
  for (const [index, item] of parsed.data.events.entries()) {
    const verdict = evaluateClassification(item, doc.body);
    if (verdict.outcome === "event" || verdict.outcome === "review") {
      await saveEvent(db, doc, verdict.draft, provenance, now, index);
      created++;
    } else {
      if (verdict.outcome === "rejected") rejected++;
      notes.push(`${verdict.outcome}: ${verdict.reason}`);
    }
  }

  if (created === 0 && rejected > 0) {
    await queueForManualReview(db, doc, "Classifier output was rejected (supporting excerpt not found in the source); categorise manually", now);
    return "queued";
  }
  const summary = created > 0 ? [`${created} event(s) recorded`, ...notes].join("; ") : notes.join("; ") || parsed.data.notQualifyingReason || "No qualifying event";
  await setDocumentState(db, doc.id, created > 0 ? "classified" : "excluded", summary);
  return created > 0 ? "classified" : "excluded";
}

/** Downloads a newly discovered filing, applies the text pre-filter and stores the text if it passes. */
async function fetchDocument(db: D1Database, doc: DocumentRow, edgar: EdgarProvider, now: Date): Promise<DocumentRow | null> {
  const c = company(doc.ticker);
  if (!c || !doc.accession || !doc.primary_document) {
    await setDocumentState(db, doc.id, "error", "Unknown company or incomplete filing reference");
    return null;
  }
  let text: string;
  try {
    text = await edgar.fetchFilingText({ cik: c.cik, accession: doc.accession, primaryDocument: doc.primary_document });
  } catch (err) {
    const attempts = doc.attempts + 1;
    const giveUp = attempts >= dashboardConfig.clinical.maxAttempts;
    await db.prepare("UPDATE documents SET attempts = ?, state = ?, state_reason = ? WHERE id = ?").bind(attempts, giveUp ? "error" : "discovered", `Fetch failed (${errorKind(err)})`, doc.id).run();
    return null;
  }
  const verdict = prefilterText(text);
  if (!verdict.pass) {
    await db.prepare("UPDATE documents SET state = 'excluded', state_reason = ?, retrieved_at = ? WHERE id = ?").bind(verdict.reason, seconds(now), doc.id).run();
    return null;
  }
  const body = truncate(text, dashboardConfig.clinical.maxInputChars);
  await db.prepare("UPDATE documents SET state = 'fetched', state_reason = NULL, body = ?, truncated = ?, retrieved_at = ? WHERE id = ?").bind(body.text, body.truncated ? 1 : 0, seconds(now), doc.id).run();
  return { ...doc, state: "fetched", body: body.text, truncated: body.truncated ? 1 : 0 };
}

export interface CycleResult {
  ran: boolean;
  step: "discover" | "process";
  discovered: number;
  processed: number;
  updated: number;
  backlog: number;
  failed: string[];
}

async function backlogCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM documents WHERE state IN ('discovered', 'fetched')").first<{ n: number }>())?.n ?? 0;
}

/**
 * One scheduled step, sized to fit a single Worker invocation. It either
 * looks for new filings or works through the backlog, newest first.
 */
export async function runClinicalCycle(db: D1Database, deps: ClinicalDeps, opts: { now?: Date; step?: "discover" | "process" } = {}): Promise<CycleResult> {
  const now = opts.now ?? new Date();
  const nowS = seconds(now);
  const manualOnly = dashboardConfig.clinical.classificationMode === "manual-only";
  const backlog = await backlogCount(db);
  const lastDiscover = (await getJobStatus(db, "clinical-discover"))?.last_attempt_at ?? null;
  const discoverDue = lastDiscover === null || (nowS - lastDiscover) * 1000 >= dashboardConfig.clinical.discoverEveryMs;
  const step = opts.step ?? (backlog === 0 || discoverDue ? "discover" : "process");

  if (step === "discover") {
    const found = await discoverDocuments(db, deps, now);
    const error = found.failed.length ? `${found.failed.length} sources failed (${[...new Set(found.reasons)].sort().join(", ")})` : null;
    await recordJobRun(db, "clinical-discover", nowS, found.failed.length, error);
    await recordJobRun(db, JOB, nowS, found.failed.length, error);
    return { ran: true, step, discovered: found.added, processed: 0, updated: found.added, backlog: await backlogCount(db), failed: found.failed };
  }

  let budget = dashboardConfig.clinical.batchSize * COST_DISCOVERED;
  let processed = 0;
  const failed: string[] = [];
  // Without a classifier, documents are still downloaded and filtered; they
  // wait in the 'fetched' state and are classified once a key is configured.
  const waitingForClassifier = !manualOnly && !deps.classifier;
  const classify = async (doc: DocumentRow) => {
    if (manualOnly) return void (await queueForManualReview(db, doc, "Awaiting manual categorisation", now));
    if (!deps.classifier) return;
    const outcome = await classifyDocument(db, doc, deps.classifier, now);
    if (outcome === "retry" || outcome === "error") failed.push(doc.id);
  };

  const stored = waitingForClassifier ? [] : (await db.prepare("SELECT * FROM documents WHERE state = 'fetched' ORDER BY published_date DESC LIMIT ?").bind(budget).all<DocumentRow>()).results;
  for (const doc of stored) {
    if (budget < COST_FETCHED) break;
    budget -= COST_FETCHED;
    await classify(doc);
    processed++;
  }

  const fresh = (await db.prepare("SELECT * FROM documents WHERE state = 'discovered' ORDER BY published_date DESC LIMIT ?").bind(Math.floor(budget / COST_DISCOVERED)).all<DocumentRow>()).results;
  for (const doc of fresh) {
    const fetched = await fetchDocument(db, doc, deps.edgar, now);
    processed++;
    if (fetched) await classify(fetched);
    else if ((await db.prepare("SELECT state FROM documents WHERE id = ?").bind(doc.id).first<{ state: string }>())?.state !== "excluded") failed.push(doc.id);
  }

  const unclassified = waitingForClassifier ? ((await db.prepare("SELECT COUNT(*) AS n FROM documents WHERE state = 'fetched'").first<{ n: number }>())?.n ?? 0) : 0;
  const error = unclassified > 0 ? "Classifier is not configured" : failed.length ? `${failed.length} documents failed` : null;
  await recordJobRun(db, JOB, nowS, failed.length + unclassified, error);
  return { ran: true, step, discovered: 0, processed, updated: processed, backlog: await backlogCount(db), failed };
}

// ---- Registry status changes ----

const REGISTRY_PHASE: Record<string, TrialPhase> = { PHASE2: "2", PHASE3: "3" };

export async function syncTrialSignals(db: D1Database, provider: TrialStatusProvider, opts: { now?: Date } = {}): Promise<{ ran: boolean; updated: number; failed: string[] }> {
  const now = opts.now ?? new Date();
  const nowS = seconds(now);
  const since = addDays(utcDate(now), -dashboardConfig.clinical.registryLookbackDays);
  const companies = allCompanies();
  const results = await mapLimit(companies, 3, (c) => provider.fetchStatusUpdates(c, since));
  const failed: string[] = [];
  const reasons: string[] = [];
  let signals = 0;

  // One read and a few batched writes, however many trials are tracked.
  const known = new Map((await db.prepare("SELECT nct_id, overall_status FROM trial_status").all<{ nct_id: string; overall_status: string }>()).results.map((r) => [r.nct_id, r.overall_status]));
  const statusWrites: D1PreparedStatement[] = [];

  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      failed.push(companies[i]!.ticker);
      reasons.push(errorKind(r.reason));
      continue;
    }
    for (const u of r.value) {
      const prior = known.get(u.nctId) ?? null;
      const signal = registrySignal(prior, u.overallStatus, u.phases, u.whyStopped);
      if (prior !== u.overallStatus) {
        known.set(u.nctId, u.overallStatus);
        statusWrites.push(
          db
            .prepare("INSERT INTO trial_status (nct_id, ticker, overall_status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(nct_id) DO UPDATE SET overall_status = excluded.overall_status, updated_at = excluded.updated_at")
            .bind(u.nctId, u.ticker, u.overallStatus, nowS),
        );
      }
      if (signal.kind === "none") continue;

      const doc: DocumentRow = {
        id: `registry:${u.nctId}:${u.overallStatus}`, source: "registry", ticker: u.ticker, form: null, accession: null, primary_document: null, items: null, title: u.title,
        url: `https://clinicaltrials.gov/study/${u.nctId}`, published_date: utcDate(now), state: signal.kind === "excluded" ? "excluded" : signal.category ? "classified" : "unclassified",
        state_reason: signal.kind === "excluded" ? signal.reason : signal.note, body: u.whyStopped, truncated: 0, attempts: 0,
      };
      const inserted = await db.prepare(INSERT_DOCUMENT).bind(doc.id, doc.source, doc.ticker, null, null, null, null, doc.title?.slice(0, 300) ?? null, doc.url, doc.published_date, doc.state, doc.state_reason?.slice(0, 500) ?? null, doc.body, 0, nowS, nowS).run();
      if (signal.kind === "excluded" || !inserted.meta?.changes) continue;

      const combined = u.phases.includes("PHASE2") && u.phases.includes("PHASE3");
      const program = [...new Set(u.interventions)].slice(0, 2).join(" + ") || u.title || u.nctId;
      await saveEvent(
        db,
        doc,
        {
          category: signal.category,
          phase: combined ? "2/3" : (REGISTRY_PHASE[u.phases.find((p) => p in REGISTRY_PHASE) ?? ""] ?? null),
          program: program.slice(0, 200),
          indication: u.conditions.slice(0, 2).join("; ").slice(0, 300) || null,
          nctId: u.nctId,
          evidenceBasis: signal.evidenceBasis,
          terminationReason: signal.terminationReason,
          summary: `ClinicalTrials.gov shows ${u.nctId} changed status to ${u.overallStatus.toLowerCase().replace(/_/g, " ")}.`,
          excerpt: u.whyStopped,
          eventDate: null,
          note: signal.note,
        },
        { origin: "registry", model: null, truncated: false },
        now,
      );
      signals++;
    }
  }

  for (let i = 0; i < statusWrites.length; i += 50) await db.batch(statusWrites.slice(i, i + 50));
  await recordJobRun(db, SIGNALS_JOB, nowS, failed.length, failed.length ? `${failed.length} of ${companies.length} companies failed (${[...new Set(reasons)].sort().join(", ")})` : null);
  return { ran: true, updated: signals, failed };
}

// ---- Reads ----

async function sourcesFor(db: D1Database, ids: string[]): Promise<Map<string, EventSource[]>> {
  const map = new Map<string, EventSource[]>();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const rows = (await db.prepare(`SELECT event_id, kind, url, label, date FROM event_sources WHERE event_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ event_id: string; kind: SourceKind; url: string; label: string; date: string | null }>()).results;
    for (const r of rows) map.set(r.event_id, [...(map.get(r.event_id) ?? []), { kind: r.kind, url: r.url, label: r.label, date: r.date }]);
  }
  for (const list of map.values()) list.sort((a, b) => SOURCE_AUTHORITY[b.kind] - SOURCE_AUTHORITY[a.kind] || (a.date ?? "").localeCompare(b.date ?? ""));
  return map;
}

export async function getClinicalFeed(db: D1Database, opts: { category?: EventCategory | null; offset?: number; limit?: number } = {}): Promise<ClinicalFeed> {
  const showUnreviewed = dashboardConfig.news.showUnreviewedEvents;
  const limit = Math.min(Math.max(opts.limit ?? dashboardConfig.news.initialPageSize, 1), 50);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Rejected events and uncategorised candidates are excluded in SQL, not just hidden in the UI.
  const where = `category IS NOT NULL AND status IN (${showUnreviewed ? "'verified', 'pending'" : "'verified'"})${opts.category ? " AND category = ?" : ""}`;
  const args = opts.category ? [opts.category] : [];

  const [rows, count, status] = await Promise.all([
    db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY announcement_date DESC, id LIMIT ? OFFSET ?`).bind(...args, limit, offset).all<EventRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where}`).bind(...args).first<{ n: number }>(),
    getJobStatus(db, JOB),
  ]);
  const sources = await sourcesFor(db, rows.results.map((r) => r.id));

  const items: ClinicalEvent[] = [];
  for (const r of rows.results) {
    const verification = publicVerification(r.status, r.category, showUnreviewed);
    if (!verification || !r.category || !r.program || !r.summary || !r.evidence_basis) continue;
    const list = sources.get(r.id) ?? [];
    items.push({
      id: r.id, ticker: r.ticker, category: r.category, phase: r.phase, program: r.program, indication: r.indication, summary: r.summary, evidenceBasis: r.evidence_basis,
      nctId: r.nct_id, announcementDate: r.announcement_date, eventDate: r.event_date, verification, lastRetrievedAt: r.last_retrieved_at, primarySource: list[0] ?? null, sources: list,
    });
  }
  const total = count?.n ?? 0;
  return {
    items, total, nextOffset: offset + rows.results.length < total ? offset + rows.results.length : null, showsUnreviewed: showUnreviewed,
    lastSuccessAt: status?.last_success_at ?? null, lastAttemptAt: status?.last_attempt_at ?? null, lastRefreshFailed: (status?.failed_count ?? 0) > 0,
  };
}

function toReviewItem(r: EventRow, sources: EventSource[]): ReviewItem {
  return {
    id: r.id, ticker: r.ticker, category: r.category, phase: r.phase, program: r.program, indication: r.indication, summary: r.summary, evidenceBasis: r.evidence_basis,
    nctId: r.nct_id, announcementDate: r.announcement_date, eventDate: r.event_date, status: r.status, excerpt: r.excerpt, note: r.note, terminationReason: r.termination_reason,
    origin: r.origin, model: r.model, promptVersion: r.prompt_version, truncated: r.truncated === 1, lastRetrievedAt: r.last_retrieved_at, reviewedAt: r.reviewed_at, sources,
  };
}

export async function listReviewItems(db: D1Database, status: ReviewStatus, limit = 100): Promise<ReviewItem[]> {
  const rows = (await db.prepare("SELECT * FROM events WHERE status = ? ORDER BY announcement_date DESC, id LIMIT ?").bind(status, limit).all<EventRow>()).results;
  const sources = await sourcesFor(db, rows.map((r) => r.id));
  return rows.map((r) => toReviewItem(r, sources.get(r.id) ?? []));
}

export interface ClinicalStatus {
  mode: string;
  model: string;
  promptVersion: string;
  classifierConfigured: boolean;
  documents: Record<string, number>;
  events: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
}

export async function getClinicalStatus(db: D1Database, classifierConfigured: boolean): Promise<ClinicalStatus> {
  const [docs, events, tokens] = await Promise.all([
    db.prepare("SELECT state AS k, COUNT(*) AS n FROM documents GROUP BY state").all<{ k: string; n: number }>(),
    db.prepare("SELECT status AS k, COUNT(*) AS n FROM events GROUP BY status").all<{ k: string; n: number }>(),
    db.prepare("SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM documents").first<{ i: number; o: number }>(),
  ]);
  const tally = (rows: Array<{ k: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
  return {
    mode: dashboardConfig.clinical.classificationMode, model: dashboardConfig.clinical.llmModel, promptVersion: dashboardConfig.clinical.promptVersion, classifierConfigured,
    documents: tally(docs.results), events: tally(events.results), inputTokens: tokens?.i ?? 0, outputTokens: tokens?.o ?? 0,
  };
}

// ---- Review actions ----

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const isoDate = z.string().refine(isIsoDate, "Use a real date in YYYY-MM-DD format");

const reviewSchema = z.object({
  category: z.enum(EVENT_CATEGORIES, "Choose a category"),
  phase: z.preprocess(blankToNull, z.enum(TRIAL_PHASES).nullable().optional()),
  program: z.string().trim().min(1, "Required").max(200, "At most 200 characters"),
  indication: z.preprocess(blankToNull, z.string().trim().max(300, "At most 300 characters").nullable().optional()),
  summary: z.string().trim().min(1, "Required").max(600, "At most 600 characters"),
  evidenceBasis: z.enum(EVIDENCE_BASES, "Choose an evidence basis"),
  nctId: z.preprocess(blankToNull, z.string().trim().regex(/^NCT\d{8}$/, "Format: NCT followed by 8 digits").nullable().optional()),
  announcementDate: isoDate,
  eventDate: z.preprocess(blankToNull, isoDate.nullable().optional()),
});

export function parseReviewInput(body: unknown): { ok: true; value: ReviewInput } | { ok: false; fields: Record<string, string> } {
  const result = reviewSchema.safeParse(body);
  if (result.success) return { ok: true, value: result.data as ReviewInput };
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    fields[key] ??= issue.code === "invalid_type" ? "Required" : issue.message;
  }
  return { ok: false, fields };
}

export type ReviewResult = { ok: true; item: ReviewItem } | { ok: false; reason: "not_found" };

async function loadReviewItem(db: D1Database, id: string): Promise<ReviewItem | null> {
  const row = await db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<EventRow>();
  return row ? toReviewItem(row, (await sourcesFor(db, [id])).get(id) ?? []) : null;
}

/** Saves corrected fields. With `confirm`, the event becomes Verified; this is the only way an event is ever verified. */
export async function saveReview(db: D1Database, id: string, input: ReviewInput, reviewer: string, confirm: boolean, now: Date = new Date()): Promise<ReviewResult> {
  if (!(await loadReviewItem(db, id))) return { ok: false, reason: "not_found" };
  const nowS = seconds(now);
  await db
    .prepare(
      `UPDATE events SET category = ?, phase = ?, program = ?, program_key = ?, indication = ?, summary = ?, evidence_basis = ?, nct_id = ?, announcement_date = ?, event_date = ?,
         status = CASE WHEN ?11 = 1 THEN 'verified' ELSE status END, reviewed_at = CASE WHEN ?11 = 1 THEN ?12 ELSE reviewed_at END,
         reviewed_by = CASE WHEN ?11 = 1 THEN ?13 ELSE reviewed_by END, updated_at = ?12 WHERE id = ?14`,
    )
    .bind(input.category, input.phase ?? null, input.program, normaliseName(input.program), input.indication ?? null, input.summary, input.evidenceBasis, input.nctId ?? null, input.announcementDate, input.eventDate && input.eventDate !== input.announcementDate ? input.eventDate : null, confirm ? 1 : 0, nowS, reviewer, id)
    .run();
  return { ok: true, item: (await loadReviewItem(db, id))! };
}

export async function rejectReview(db: D1Database, id: string, reviewer: string, now: Date = new Date()): Promise<ReviewResult> {
  if (!(await loadReviewItem(db, id))) return { ok: false, reason: "not_found" };
  const nowS = seconds(now);
  await db.prepare("UPDATE events SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?").bind(nowS, reviewer, nowS, id).run();
  return { ok: true, item: (await loadReviewItem(db, id))! };
}
