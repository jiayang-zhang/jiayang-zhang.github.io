import { z } from "zod";
import { addDays, applyManualOverrides, inFeedWindow, isIsoDate, sortChronologically, utcDate } from "../../../shared/catalysts";
import { allCompanies, dashboardConfig } from "../../../shared/config";
import type { AdminCatalyst, Catalyst, CatalystFeed, CatalystInput } from "../../../shared/types";
import { getJobStatus, recordJobRun } from "../db";
import { mapLimit, UpstreamError } from "../lib/http";
import type { RegistryProvider, RegistryReadout } from "../providers/clinicaltrials";

const JOB = "catalysts";
const REGISTRY_SOURCE = "ClinicalTrials.gov";
const PHASE_LABELS: Record<string, string> = { PHASE1: "Phase I", PHASE2: "Phase II", PHASE3: "Phase III" };

interface Row {
  id: string;
  ticker: string;
  program: string;
  indication: string | null;
  event_type: Catalyst["eventType"];
  date_start: string;
  date_end: string | null;
  status: Catalyst["status"];
  origin: Catalyst["origin"];
  nct_id: string | null;
  phase: string | null;
  source_url: string | null;
  source_name: string | null;
  notes: string | null;
  last_verified_at: number | null;
  previous_date_start: string | null;
  date_changed_at: number | null;
  registry_date_type: Catalyst["registryDateType"];
  created_at: number;
  updated_at: number;
}

function fromRow(r: Row): AdminCatalyst {
  return {
    id: r.id,
    ticker: r.ticker,
    program: r.program,
    indication: r.indication,
    eventType: r.event_type,
    dateStart: r.date_start,
    dateEnd: r.date_end,
    status: r.status,
    origin: r.origin,
    nctId: r.nct_id,
    phase: r.phase,
    sourceUrl: r.source_url,
    sourceName: r.source_name,
    lastVerifiedAt: r.last_verified_at,
    previousDateStart: r.previous_date_start,
    dateChangedAt: r.date_changed_at,
    registryDateType: r.registry_date_type,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Drops the fields visitors must not receive. */
export function toPublicCatalyst(c: AdminCatalyst): Catalyst {
  const { notes: _notes, createdAt: _createdAt, updatedAt: _updatedAt, ...pub } = c;
  return pub;
}

const UPSERT = `INSERT INTO catalysts (id, ticker, program, indication, event_type, date_start, date_end, status, origin, nct_id, phase,
    source_url, source_name, notes, last_verified_at, previous_date_start, date_changed_at, registry_date_type, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET ticker = excluded.ticker, program = excluded.program, indication = excluded.indication,
    event_type = excluded.event_type, date_start = excluded.date_start, date_end = excluded.date_end, status = excluded.status,
    nct_id = excluded.nct_id, phase = excluded.phase, source_url = excluded.source_url, source_name = excluded.source_name,
    notes = excluded.notes, last_verified_at = excluded.last_verified_at, previous_date_start = excluded.previous_date_start,
    date_changed_at = excluded.date_changed_at, registry_date_type = excluded.registry_date_type, updated_at = excluded.updated_at`;

function upsertStatement(db: D1Database, c: AdminCatalyst) {
  return db
    .prepare(UPSERT)
    .bind(c.id, c.ticker, c.program, c.indication, c.eventType, c.dateStart, c.dateEnd, c.status, c.origin, c.nctId, c.phase, c.sourceUrl, c.sourceName, c.notes, c.lastVerifiedAt, c.previousDateStart, c.dateChangedAt, c.registryDateType, c.createdAt, c.updatedAt);
}

async function loadAll(db: D1Database): Promise<AdminCatalyst[]> {
  return (await db.prepare("SELECT * FROM catalysts").all<Row>()).results.map(fromRow);
}

async function loadOne(db: D1Database, id: string): Promise<AdminCatalyst | null> {
  const row = await db.prepare("SELECT * FROM catalysts WHERE id = ?").bind(id).first<Row>();
  return row ? fromRow(row) : null;
}

// ---- Reads ----

export async function listAdminCatalysts(db: D1Database): Promise<AdminCatalyst[]> {
  return sortChronologically(await loadAll(db));
}

export async function getCatalystFeed(db: D1Database, now: Date = new Date()): Promise<CatalystFeed> {
  const today = utcDate(now);
  const [all, status] = await Promise.all([loadAll(db), getJobStatus(db, JOB)]);
  const items = applyManualOverrides(all)
    .filter((c) => c.origin === "manual" || dashboardConfig.catalysts.includeRegistryEstimatedReadouts)
    .filter((c) => inFeedWindow(c, today));
  return {
    today,
    lookAheadDays: dashboardConfig.catalysts.lookAheadDays,
    lastSuccessAt: status?.last_success_at ?? null,
    lastAttemptAt: status?.last_attempt_at ?? null,
    lastRefreshFailed: (status?.failed_count ?? 0) > 0,
    items: sortChronologically(items).map(toPublicCatalyst),
  };
}

// ---- Manual entries ----

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max, `At most ${max} characters`).nullable().optional());
const isoDate = z.string().refine(isIsoDate, "Use a real date in YYYY-MM-DD format");
const httpUrl = z.string().trim().max(500).refine((v) => {
  try {
    return ["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}, "Use a full http(s) URL");

const inputSchema = z
  .object({
    ticker: z.string().refine((t) => allCompanies().some((c) => c.ticker === t), "Choose a watchlist company"),
    program: z.string().trim().min(1, "Required").max(200, "At most 200 characters"),
    indication: optionalText(300),
    eventType: z.enum(["pdufa", "readout", "adcom"], "Choose an event type"),
    dateStart: isoDate,
    dateEnd: z.preprocess(blankToNull, isoDate.nullable().optional()),
    status: z.enum(["confirmed", "estimated", "unverified"], "Choose a status"),
    nctId: z.preprocess(blankToNull, z.string().trim().regex(/^NCT\d{8}$/, "Format: NCT followed by 8 digits").nullable().optional()),
    sourceUrl: z.preprocess(blankToNull, httpUrl.nullable().optional()),
    sourceName: optionalText(120),
    notes: optionalText(2000),
  })
  .refine((v) => !v.dateEnd || v.dateEnd >= v.dateStart, { path: ["dateEnd"], message: "End date cannot be before the start date" });

export type ParsedInput = { ok: true; value: CatalystInput } | { ok: false; fields: Record<string, string> };

export function parseCatalystInput(body: unknown): ParsedInput {
  const result = inputSchema.safeParse(body);
  if (result.success) return { ok: true, value: result.data as CatalystInput };
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    fields[key] ??= issue.code === "invalid_type" ? "Required" : issue.message;
  }
  return { ok: false, fields };
}

function applyInput(base: Pick<AdminCatalyst, "id" | "createdAt" | "previousDateStart" | "dateChangedAt">, input: CatalystInput, nowS: number): AdminCatalyst {
  return {
    ...base,
    ticker: input.ticker,
    program: input.program,
    indication: input.indication ?? null,
    eventType: input.eventType,
    dateStart: input.dateStart,
    dateEnd: input.dateEnd ?? null,
    status: input.status,
    origin: "manual",
    nctId: input.nctId ?? null,
    phase: null,
    sourceUrl: input.sourceUrl ?? null,
    sourceName: input.sourceName ?? null,
    notes: input.notes ?? null,
    // Saving an entry counts as the administrator having checked it.
    lastVerifiedAt: nowS,
    registryDateType: null,
    updatedAt: nowS,
  };
}

export async function createCatalyst(db: D1Database, input: CatalystInput, now: Date = new Date()): Promise<AdminCatalyst> {
  const nowS = Math.floor(now.getTime() / 1000);
  const created = applyInput({ id: crypto.randomUUID(), createdAt: nowS, previousDateStart: null, dateChangedAt: null }, input, nowS);
  await upsertStatement(db, created).run();
  return created;
}

export type MutationResult = { ok: true; catalyst: AdminCatalyst } | { ok: false; reason: "not_found" | "registry_entry" };

export async function updateCatalyst(db: D1Database, id: string, input: CatalystInput, now: Date = new Date()): Promise<MutationResult> {
  const existing = await loadOne(db, id);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.origin !== "manual") return { ok: false, reason: "registry_entry" };
  const nowS = Math.floor(now.getTime() / 1000);
  const moved = existing.dateStart !== input.dateStart;
  const updated = applyInput(
    {
      id,
      createdAt: existing.createdAt,
      previousDateStart: moved ? existing.dateStart : existing.previousDateStart,
      dateChangedAt: moved ? nowS : existing.dateChangedAt,
    },
    input,
    nowS,
  );
  await upsertStatement(db, updated).run();
  return { ok: true, catalyst: updated };
}

export async function deleteCatalyst(db: D1Database, id: string): Promise<MutationResult> {
  const existing = await loadOne(db, id);
  if (!existing) return { ok: false, reason: "not_found" };
  // Registry entries are regenerated on every sync; override them with a manual entry instead.
  if (existing.origin !== "manual") return { ok: false, reason: "registry_entry" };
  await db.prepare("DELETE FROM catalysts WHERE id = ?").bind(id).run();
  return { ok: true, catalyst: existing };
}

// ---- Registry-derived estimated readouts ----

function describeReadout(r: RegistryReadout) {
  const unique = [...new Set(r.interventions)];
  return {
    program: (unique.slice(0, 2).join(" + ") || r.title || r.nctId).slice(0, 200),
    indication: r.conditions.slice(0, 2).join("; ").slice(0, 300) || null,
    phase: r.phases.map((p) => PHASE_LABELS[p] ?? p).join("/") || null,
  };
}

/**
 * Works out what a sync should write. Entries are added and updated from the
 * registry, flagged when their date moves, and removed when the trial no
 * longer falls in the window. Only companies whose fetch succeeded are
 * touched, so a failed request never deletes that company's entries.
 */
export function reconcileRegistry(existing: AdminCatalyst[], fetched: RegistryReadout[], syncedTickers: Set<string>, nowS: number): { upserts: AdminCatalyst[]; deleteIds: string[] } {
  const registry = existing.filter((c) => c.origin === "registry");
  const byTrial = new Map(registry.map((c) => [c.nctId, c]));
  const seen = new Set<string>();
  const upserts: AdminCatalyst[] = [];

  for (const r of fetched) {
    if (!syncedTickers.has(r.ticker) || seen.has(r.nctId)) continue;
    seen.add(r.nctId);
    const prior = byTrial.get(r.nctId);
    const moved = prior !== undefined && prior.dateStart !== r.dateStart;
    upserts.push({
      id: prior?.id ?? `registry-${r.nctId}`,
      ticker: r.ticker,
      ...describeReadout(r),
      eventType: "readout",
      dateStart: r.dateStart,
      dateEnd: r.dateEnd,
      status: "estimated",
      origin: "registry",
      nctId: r.nctId,
      sourceUrl: `https://clinicaltrials.gov/study/${r.nctId}`,
      sourceName: REGISTRY_SOURCE,
      notes: null,
      lastVerifiedAt: nowS,
      previousDateStart: moved ? prior.dateStart : (prior?.previousDateStart ?? null),
      dateChangedAt: moved ? nowS : (prior?.dateChangedAt ?? null),
      registryDateType: r.dateType,
      createdAt: prior?.createdAt ?? nowS,
      updatedAt: nowS,
    });
  }

  const deleteIds = registry.filter((c) => syncedTickers.has(c.ticker) && !seen.has(c.nctId ?? "")).map((c) => c.id);
  return { upserts, deleteIds };
}

export interface SyncResult {
  ran: boolean;
  updated: number;
  removed: number;
  failed: string[];
}

export async function syncRegistryCatalysts(db: D1Database, provider: RegistryProvider, opts: { now?: Date } = {}): Promise<SyncResult> {
  if (!dashboardConfig.catalysts.includeRegistryEstimatedReadouts) return { ran: false, updated: 0, removed: 0, failed: [] };
  const now = opts.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const today = utcDate(now);
  const from = addDays(today, -dashboardConfig.catalysts.overdueGraceDays);
  const to = addDays(today, dashboardConfig.catalysts.lookAheadDays);

  const companies = allCompanies();
  const results = await mapLimit(companies, 3, (c) => provider.fetchReadouts(c, from, to));

  const fetched: RegistryReadout[] = [];
  const synced = new Set<string>();
  const failed: string[] = [];
  const reasons: unknown[] = [];
  results.forEach((r, i) => {
    const ticker = companies[i]!.ticker;
    if (r.status === "fulfilled") {
      synced.add(ticker);
      fetched.push(...r.value);
    } else {
      failed.push(ticker);
      reasons.push(r.reason);
    }
  });

  const { upserts, deleteIds } = reconcileRegistry(await loadAll(db), fetched, synced, nowS);
  const statements = [...upserts.map((c) => upsertStatement(db, c)), ...deleteIds.map((id) => db.prepare("DELETE FROM catalysts WHERE id = ?").bind(id))];
  // D1 caps statements per batch; stay well below it.
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));

  const kinds = [...new Set(reasons.map((r) => (r instanceof UpstreamError ? r.kind : "error")))].sort();
  await recordJobRun(db, JOB, nowS, failed.length, failed.length ? `${failed.length} of ${companies.length} companies failed (${kinds.join(", ")})` : null);
  return { ran: true, updated: upserts.length, removed: deleteIds.length, failed };
}
