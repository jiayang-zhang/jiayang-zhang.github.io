import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyManualOverrides, catalystTiming, dateRecentlyChanged, inFeedWindow, isIsoDate } from "../../shared/catalysts";
import { allCompanies } from "../../shared/config";
import type { AdminCatalyst, CatalystFeed, CatalystInput } from "../../shared/types";
import { createApp } from "../../worker/src/app";
import type { Env } from "../../worker/src/env";
import { UpstreamError } from "../../worker/src/lib/http";
import { resetRateLimits } from "../../worker/src/lib/ratelimit";
import { createClinicalTrialsProvider, expandRegistryDate, phaseQualifies, sponsorMatches, type RegistryProvider, type RegistryReadout } from "../../worker/src/providers/clinicaltrials";
import { createCatalyst, deleteCatalyst, getCatalystFeed, listAdminCatalysts, parseCatalystInput, syncRegistryCatalysts, updateCatalyst } from "../../worker/src/services/catalysts";
import { createTestDb } from "./d1";

const NOW = new Date("2026-10-10T12:00:00Z");
const TODAY = "2026-10-10";
const company = (t: string) => allCompanies().find((c) => c.ticker === t)!;

const readout = (over: Partial<RegistryReadout> = {}): RegistryReadout => ({
  ticker: "INSM", nctId: "NCT00000001", title: "A study", phases: ["PHASE3"], overallStatus: "ACTIVE_NOT_RECRUITING",
  dateStart: "2026-11-15", dateEnd: null, dateType: "ANTICIPATED", conditions: ["Bronchiectasis"], interventions: ["Brensocatib"], ...over,
});

/** Registry fake: returns the readouts for each ticker, or throws for tickers listed in `down`. */
const registry = (readouts: RegistryReadout[], down: string[] = []): RegistryProvider => ({
  async fetchReadouts(c) {
    if (down.includes(c.ticker)) throw new UpstreamError("timeout");
    return readouts.filter((r) => r.ticker === c.ticker);
  },
});

const manual = (over: Partial<CatalystInput> = {}): CatalystInput => ({ ticker: "MDGL", program: "Rezdiffra", eventType: "pdufa", dateStart: "2026-11-01", status: "confirmed", ...over });

let db: D1Database;
beforeEach(() => {
  db = createTestDb();
});

describe("dates and timing", () => {
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026/01/01", "2026-1-1", "", null, 20260101]) expect(isIsoDate(bad)).toBe(false);
  });

  it("counts days, highlights the next seven days and labels overdue events", () => {
    expect(catalystTiming({ dateStart: "2026-10-24", dateEnd: null }, TODAY)).toMatchObject({ daysUntil: 14, imminent: false, overdue: false, label: "In 14 days" });
    expect(catalystTiming({ dateStart: "2026-10-17", dateEnd: null }, TODAY)).toMatchObject({ daysUntil: 7, imminent: true });
    expect(catalystTiming({ dateStart: "2026-10-18", dateEnd: null }, TODAY).imminent).toBe(false);
    expect(catalystTiming({ dateStart: "2026-10-11", dateEnd: null }, TODAY).label).toBe("In 1 day");
    expect(catalystTiming({ dateStart: TODAY, dateEnd: null }, TODAY)).toMatchObject({ label: "Today", imminent: true, overdue: false });
    expect(catalystTiming({ dateStart: "2026-10-07", dateEnd: null }, TODAY)).toMatchObject({ overdue: true, imminent: false, label: "Overdue by 3 days" });
  });

  it("treats a date range as current until its end has passed", () => {
    expect(catalystTiming({ dateStart: "2026-10-01", dateEnd: "2026-10-31" }, TODAY)).toMatchObject({ overdue: false, ongoing: true, imminent: false, label: "In window now" });
    expect(catalystTiming({ dateStart: "2026-10-01", dateEnd: "2026-10-15" }, TODAY)).toMatchObject({ ongoing: true, imminent: true });
    expect(catalystTiming({ dateStart: "2026-10-09", dateEnd: null }, TODAY).imminent).toBe(false);
    expect(catalystTiming({ dateStart: "2026-09-01", dateEnd: "2026-09-30" }, TODAY)).toMatchObject({ overdue: true, label: "Overdue by 10 days" });
  });

  it("keeps events within 90 days ahead and 30 days of overdue grace", () => {
    expect(inFeedWindow({ dateStart: "2027-01-08", dateEnd: null }, TODAY)).toBe(true);
    expect(inFeedWindow({ dateStart: "2027-01-09", dateEnd: null }, TODAY)).toBe(false);
    expect(inFeedWindow({ dateStart: "2026-09-10", dateEnd: null }, TODAY)).toBe(true);
    expect(inFeedWindow({ dateStart: "2026-09-09", dateEnd: null }, TODAY)).toBe(false);
  });

  it("drops the date-changed label after 30 days", () => {
    const at = Math.floor(NOW.getTime() / 1000);
    expect(dateRecentlyChanged({ previousDateStart: "2026-10-01", dateChangedAt: at - 86_400 }, at)).toBe(true);
    expect(dateRecentlyChanged({ previousDateStart: "2026-10-01", dateChangedAt: at - 31 * 86_400 }, at)).toBe(false);
    expect(dateRecentlyChanged({ previousDateStart: null, dateChangedAt: null }, at)).toBe(false);
  });

  it("lets a manual entry replace the registry estimate for the same trial only", () => {
    const kept = applyManualOverrides([
      { id: "r1", origin: "registry", nctId: "NCT00000001" },
      { id: "r2", origin: "registry", nctId: "NCT00000002" },
      { id: "m1", origin: "manual", nctId: "NCT00000001" },
      { id: "m2", origin: "manual", nctId: null },
    ] as never[]) as Array<{ id: string }>;
    expect(kept.map((c) => c.id)).toEqual(["r2", "m1", "m2"]);
  });
});

describe("ClinicalTrials.gov provider", () => {
  it("expands month-precision dates to the whole month", () => {
    expect(expandRegistryDate("2026-12-15")).toEqual({ dateStart: "2026-12-15", dateEnd: null });
    expect(expandRegistryDate("2026-12")).toEqual({ dateStart: "2026-12-01", dateEnd: "2026-12-31" });
    expect(expandRegistryDate("2028-02")).toEqual({ dateStart: "2028-02-01", dateEnd: "2028-02-29" });
  });

  it("includes Phase II, III and II/III, and excludes Phase I/II unless enabled", () => {
    expect(phaseQualifies(["PHASE2"])).toBe(true);
    expect(phaseQualifies(["PHASE3"])).toBe(true);
    expect(phaseQualifies(["PHASE2", "PHASE3"])).toBe(true);
    expect(phaseQualifies(["PHASE1", "PHASE2"])).toBe(false);
    expect(phaseQualifies(["PHASE1", "PHASE2"], true)).toBe(true);
    expect(phaseQualifies(["PHASE1"], true)).toBe(false);
    expect(phaseQualifies(["PHASE4"])).toBe(false);
    expect(phaseQualifies([])).toBe(false);
  });

  it("does not match an unrelated sponsor with a similar name", () => {
    expect(sponsorMatches(company("MRK"), "Merck Sharp & Dohme LLC")).toBe(true);
    expect(sponsorMatches(company("MRK"), "Merck KGaA, Darmstadt, Germany")).toBe(false);
    expect(sponsorMatches(company("BBIO"), "QED Therapeutics, a BridgeBio company")).toBe(true);
    expect(sponsorMatches(company("PFE"), undefined)).toBe(false);
  });

  const study = (nctId: string, over: { date?: string; type?: string; phases?: string[]; sponsor?: string } = {}) => ({
    protocolSection: {
      identificationModule: { nctId, briefTitle: `Title ${nctId}` },
      statusModule: { overallStatus: "RECRUITING", primaryCompletionDateStruct: { date: over.date ?? "2026-12", type: over.type ?? "ESTIMATED" } },
      sponsorCollaboratorsModule: { leadSponsor: { name: over.sponsor ?? "Insmed Incorporated" } },
      conditionsModule: { conditions: ["PAH"] },
      designModule: { phases: over.phases ?? ["PHASE2", "PHASE3"] },
      armsInterventionsModule: { interventions: [{ name: "Placebo", type: "DRUG" }, { name: "TPIP Placebo", type: "DRUG" }, { name: "TPIP", type: "DRUG" }] },
    },
  });

  it("maps studies, follows pagination and filters phase and sponsor", async () => {
    const pages = [
      { studies: [study("NCT00000001"), study("NCT00000002", { phases: ["PHASE1", "PHASE2"] })], nextPageToken: "abc" },
      { studies: [study("NCT00000003", { sponsor: "Somebody Else" }), study("NCT00000004", { date: "2026-11-20", type: "ACTUAL", phases: ["PHASE3"] })] },
    ];
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify(pages.shift())));
    const out = await createClinicalTrialsProvider({ fetchImpl }).fetchReadouts(company("INSM"), "2026-09-10", "2027-01-08");

    expect(out.map((r) => r.nctId)).toEqual(["NCT00000001", "NCT00000004"]);
    expect(out[0]).toMatchObject({ ticker: "INSM", dateStart: "2026-12-01", dateEnd: "2026-12-31", dateType: "ANTICIPATED", interventions: ["TPIP"] });
    expect(out[1]).toMatchObject({ dateStart: "2026-11-20", dateEnd: null, dateType: "ACTUAL" });

    const first = new URL(fetchImpl.mock.calls[0]![0]);
    expect(first.searchParams.get("query.lead")).toBe("Insmed");
    expect(first.searchParams.get("filter.advanced")).toBe("AREA[Phase](PHASE2 OR PHASE3) AND AREA[PrimaryCompletionDate]RANGE[2026-09-10,2027-01-08]");
    expect(new URL(fetchImpl.mock.calls[1]![0]).searchParams.get("pageToken")).toBe("abc");
  });

  it("rejects a malformed registry response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ studies: [{ protocolSection: { identificationModule: { nctId: "bad" } } }] })));
    await expect(createClinicalTrialsProvider({ fetchImpl }).fetchReadouts(company("ARGX"), "2026-09-11", "2027-01-09")).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("registry-derived estimated readouts", () => {
  it("creates Estimated entries sourced to ClinicalTrials.gov", async () => {
    const r = await syncRegistryCatalysts(db, registry([readout()]), { now: NOW });
    expect(r).toMatchObject({ ran: true, updated: 1, removed: 0, failed: [] });
    const feed = await getCatalystFeed(db, NOW);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      ticker: "INSM", eventType: "readout", status: "estimated", origin: "registry", nctId: "NCT00000001", program: "Brensocatib",
      indication: "Bronchiectasis", phase: "Phase III", sourceName: "ClinicalTrials.gov", sourceUrl: "https://clinicaltrials.gov/study/NCT00000001",
      registryDateType: "ANTICIPATED", previousDateStart: null,
    });
    expect(feed.lastSuccessAt).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it("records the old date when the registry date moves, and keeps it on later syncs", async () => {
    await syncRegistryCatalysts(db, registry([readout()]), { now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);
    await syncRegistryCatalysts(db, registry([readout({ dateStart: "2026-12-20" })]), { now: later });
    let item = (await getCatalystFeed(db, later)).items[0]!;
    expect(item).toMatchObject({ dateStart: "2026-12-20", previousDateStart: "2026-11-15", dateChangedAt: Math.floor(later.getTime() / 1000) });

    await syncRegistryCatalysts(db, registry([readout({ dateStart: "2026-12-20" })]), { now: new Date(later.getTime() + 3_600_000) });
    item = (await getCatalystFeed(db, later)).items[0]!;
    expect(item.previousDateStart).toBe("2026-11-15");
    expect(await listAdminCatalysts(db)).toHaveLength(1);
  });

  it("marks a date the registry reports as Actual", async () => {
    await syncRegistryCatalysts(db, registry([readout({ dateStart: "2026-10-02", dateType: "ACTUAL" })]), { now: NOW });
    const item = (await getCatalystFeed(db, NOW)).items[0]!;
    expect(item.registryDateType).toBe("ACTUAL");
    expect(catalystTiming(item, TODAY).overdue).toBe(true);
  });

  it("removes an entry when the trial leaves the registry results", async () => {
    await syncRegistryCatalysts(db, registry([readout(), readout({ nctId: "NCT00000002" })]), { now: NOW });
    const r = await syncRegistryCatalysts(db, registry([readout()]), { now: NOW });
    expect(r.removed).toBe(1);
    expect((await getCatalystFeed(db, NOW)).items.map((c) => c.nctId)).toEqual(["NCT00000001"]);
  });

  it("leaves a company's entries alone when its registry request fails", async () => {
    await syncRegistryCatalysts(db, registry([readout(), readout({ ticker: "ARGX", nctId: "NCT00000009" })]), { now: NOW });
    const r = await syncRegistryCatalysts(db, registry([readout({ ticker: "ARGX", nctId: "NCT00000009" })], ["INSM"]), { now: NOW });
    expect(r.failed).toEqual(["INSM"]);
    expect(r.removed).toBe(0);
    const feed = await getCatalystFeed(db, NOW);
    expect(feed.items.map((c) => c.ticker).sort()).toEqual(["ARGX", "INSM"]);
    expect(feed.lastRefreshFailed).toBe(true);
  });

  it("is overridden by a manual entry for the same trial, and returns if that entry is deleted", async () => {
    await syncRegistryCatalysts(db, registry([readout(), readout({ nctId: "NCT00000002", dateStart: "2026-11-20" })]), { now: NOW });
    const mine = await createCatalyst(db, manual({ ticker: "INSM", program: "Brensocatib", eventType: "readout", dateStart: "2026-12-05", nctId: "NCT00000001" }), NOW);

    let items = (await getCatalystFeed(db, NOW)).items;
    expect(items.map((c) => `${c.origin}:${c.nctId}`)).toEqual(["registry:NCT00000002", "manual:NCT00000001"]);
    expect(items.find((c) => c.nctId === "NCT00000001")).toMatchObject({ status: "confirmed", dateStart: "2026-12-05" });

    await syncRegistryCatalysts(db, registry([readout(), readout({ nctId: "NCT00000002", dateStart: "2026-11-20" })]), { now: NOW });
    expect((await getCatalystFeed(db, NOW)).items.filter((c) => c.nctId === "NCT00000001")).toHaveLength(1);

    await deleteCatalyst(db, mine.id);
    items = (await getCatalystFeed(db, NOW)).items;
    expect(items.find((c) => c.nctId === "NCT00000001")).toMatchObject({ origin: "registry", status: "estimated" });
  });

  it("handles a batch larger than one database batch", async () => {
    const many = Array.from({ length: 120 }, (_, i) => readout({ nctId: `NCT${String(10_000_000 + i)}` }));
    expect((await syncRegistryCatalysts(db, registry(many), { now: NOW })).updated).toBe(120);
    expect((await getCatalystFeed(db, NOW)).items).toHaveLength(120);
  });
});

describe("manual entries", () => {
  it("can be added, edited and deleted, and persist in the database", async () => {
    const created = await createCatalyst(db, manual({ notes: "private note", sourceUrl: "https://example.com/pr" }), NOW);
    expect((await listAdminCatalysts(db))[0]).toMatchObject({ id: created.id, program: "Rezdiffra", notes: "private note", origin: "manual", lastVerifiedAt: Math.floor(NOW.getTime() / 1000) });

    const edited = await updateCatalyst(db, created.id, manual({ program: "Resmetirom", dateStart: "2026-11-20", status: "unverified" }), NOW);
    expect(edited).toMatchObject({ ok: true });
    expect((await listAdminCatalysts(db))[0]).toMatchObject({ program: "Resmetirom", dateStart: "2026-11-20", previousDateStart: "2026-11-01", status: "unverified", createdAt: created.createdAt });

    expect(await deleteCatalyst(db, created.id)).toMatchObject({ ok: true });
    expect(await listAdminCatalysts(db)).toEqual([]);
    expect(await deleteCatalyst(db, created.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses to edit or delete registry entries directly", async () => {
    await syncRegistryCatalysts(db, registry([readout()]), { now: NOW });
    const id = (await listAdminCatalysts(db))[0]!.id;
    expect(await updateCatalyst(db, id, manual())).toEqual({ ok: false, reason: "registry_entry" });
    expect(await deleteCatalyst(db, id)).toEqual({ ok: false, reason: "registry_entry" });
  });

  it("sorts the feed chronologically and applies the window", async () => {
    await createCatalyst(db, manual({ program: "far", dateStart: "2027-06-01" }), NOW);
    await createCatalyst(db, manual({ program: "soon", dateStart: "2026-10-12" }), NOW);
    await createCatalyst(db, manual({ program: "overdue", dateStart: "2026-10-01" }), NOW);
    await createCatalyst(db, manual({ program: "ancient", dateStart: "2026-01-01" }), NOW);
    await createCatalyst(db, manual({ program: "adcom", eventType: "adcom", dateStart: "2026-11-01", dateEnd: "2026-11-02" }), NOW);
    expect((await getCatalystFeed(db, NOW)).items.map((c) => c.program)).toEqual(["overdue", "soon", "adcom"]);
    expect(await listAdminCatalysts(db)).toHaveLength(5);
  });

  it("validates required fields, formats and date order", () => {
    expect(parseCatalystInput(manual())).toMatchObject({ ok: true });
    expect(parseCatalystInput(manual({ indication: "  ", dateEnd: "", nctId: "", sourceUrl: "" } as never))).toMatchObject({ ok: true, value: { indication: null, dateEnd: null, nctId: null, sourceUrl: null } });

    const bad = parseCatalystInput({ ticker: "PPH", program: " ", eventType: "earnings", dateStart: "2026-02-30", dateEnd: "2026-01-01", status: "sure", nctId: "NCT123", sourceUrl: "javascript:alert(1)" });
    expect(bad.ok).toBe(false);
    expect(Object.keys((bad as { fields: object }).fields).sort()).toEqual(["dateStart", "eventType", "nctId", "program", "sourceUrl", "status", "ticker"]);

    expect(parseCatalystInput(manual({ dateEnd: "2026-10-01" }))).toMatchObject({ ok: false, fields: { dateEnd: "End date cannot be before the start date" } });
    expect(parseCatalystInput({})).toMatchObject({ ok: false, fields: { ticker: "Required", program: "Required", dateStart: "Required" } });
    expect(parseCatalystInput(null).ok).toBe(false);
  });
});

describe("catalyst API", () => {
  const TEAM = "https://team.cloudflareaccess.com";
  const ORIGIN = "https://jiayangzh.com";
  const API = "https://api.jiayangzh.com";
  let token: string;
  let app: ReturnType<typeof createApp>;
  let env: Env;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "RS256" }] });
    token = await new SignJWT({ email: "owner@example.com" }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(TEAM).setAudience("aud").setExpirationTime("1h").sign(privateKey);
    app = createApp({ auth: { getKey }, registry: () => registry([readout()]) });
  });

  beforeEach(() => {
    resetRateLimits();
    env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud", ADMIN_EMAILS: "owner@example.com", ALLOWED_ORIGINS: ORIGIN };
  });

  const admin = (path: string, method = "GET", body?: unknown) =>
    app.request(`${API}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN, "X-Biotech-Admin": "1", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const anon = (path: string, method = "GET", body?: unknown) =>
    app.request(`${API}${path}`, { method, headers: { Origin: ORIGIN, "X-Biotech-Admin": "1", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

  it("supports the full add, edit, delete cycle for the administrator", async () => {
    const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const created = await admin("/admin/catalysts", "POST", manual({ dateStart: future, notes: "internal" }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as AdminCatalyst;

    const feed = (await (await anon("/v1/catalysts")).json()) as CatalystFeed;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ id, program: "Rezdiffra", status: "confirmed" });

    expect((await admin(`/admin/catalysts/${id}`, "PUT", manual({ dateStart: future, program: "Edited" }))).status).toBe(200);
    expect(((await (await anon("/v1/catalysts")).json()) as CatalystFeed).items[0]!.program).toBe("Edited");

    expect((await admin(`/admin/catalysts/${id}`, "DELETE")).status).toBe(200);
    expect(((await (await anon("/v1/catalysts")).json()) as CatalystFeed).items).toEqual([]);

    const audit = (await db.prepare("SELECT action FROM audit_log ORDER BY id").all<{ action: string }>()).results.map((r) => r.action);
    expect(audit).toEqual(["catalyst.create", "catalyst.update", "catalyst.delete"]);
  });

  it("never sends admin-only fields to visitors", async () => {
    const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await admin("/admin/catalysts", "POST", manual({ dateStart: future, notes: "SECRET-NOTE" }));
    const text = await (await anon("/v1/catalysts")).text();
    expect(text).not.toMatch(/SECRET-NOTE|notes|createdAt|updatedAt/);
    expect(await (await admin("/admin/catalysts")).text()).toContain("SECRET-NOTE");
  });

  it("rejects every catalyst write and the admin list without a session", async () => {
    const calls: Array<[string, string]> = [["/admin/catalysts", "GET"], ["/admin/catalysts", "POST"], ["/admin/catalysts/x", "PUT"], ["/admin/catalysts/x", "DELETE"], ["/admin/refresh/catalysts", "POST"]];
    for (const [path, method] of calls) expect((await anon(path, method, method === "GET" || method === "DELETE" ? undefined : manual())).status, `${method} ${path}`).toBe(401);
    expect(await listAdminCatalysts(db)).toEqual([]);
    for (const method of ["POST", "PUT", "DELETE"]) expect((await anon("/v1/catalysts", method)).status).toBe(404);
  });

  it("returns field errors for invalid input and proper codes for missing or registry entries", async () => {
    const invalid = await admin("/admin/catalysts", "POST", { ticker: "LLY" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { fields: Record<string, string> }).fields.program).toBe("Required");
    expect((await app.request(`${API}/admin/catalysts`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN, "X-Biotech-Admin": "1" }, body: "{not json" }, env)).status).toBe(400);

    expect((await admin("/admin/catalysts/nope", "PUT", manual())).status).toBe(404);
    expect((await admin("/admin/catalysts/nope", "DELETE")).status).toBe(404);

    const sync = await admin("/admin/refresh/catalysts", "POST");
    expect(await sync.json()).toMatchObject({ ran: true, updated: 1 });
    expect((await admin("/admin/catalysts/registry-NCT00000001", "DELETE")).status).toBe(409);
    expect((await admin("/admin/catalysts/registry-NCT00000001", "PUT", manual())).status).toBe(409);
  });

  it("serves an empty feed when nothing has been collected", async () => {
    const feed = (await (await anon("/v1/catalysts")).json()) as CatalystFeed;
    expect(feed).toMatchObject({ items: [], lastSuccessAt: null, lookAheadDays: 90 });
  });
});
