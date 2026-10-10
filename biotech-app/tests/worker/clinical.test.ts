import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { allCompanies, dashboardConfig } from "../../shared/config";
import { publicVerification, type ClinicalFeed, type ReviewInput, type ReviewItem } from "../../shared/events";
import { createApp } from "../../worker/src/app";
import { prefilterFilingMetadata, prefilterText } from "../../worker/src/clinical/prefilter";
import { classifyTerminationReason, evaluateClassification, registrySignal, type ClassifiedEvent } from "../../worker/src/clinical/rules";
import { containsExcerpt, htmlToText, truncate } from "../../worker/src/clinical/text";
import type { Env } from "../../worker/src/env";
import { UpstreamError } from "../../worker/src/lib/http";
import { resetRateLimits } from "../../worker/src/lib/ratelimit";
import { createAnthropicClassifier, type Classifier } from "../../worker/src/providers/classifier";
import type { TrialStatusProvider, TrialStatusUpdate } from "../../worker/src/providers/clinicaltrials";
import { createEdgarProvider, filingUrl, pickDocuments, type EdgarProvider, type FilingRef } from "../../worker/src/providers/edgar";
import { parseFeed, type NewsProvider } from "../../worker/src/providers/rss";
import { getClinicalFeed, getClinicalStatus, listReviewItems, parseReviewInput, rejectReview, runClinicalCycle, saveReview, syncTrialSignals, type ClinicalDeps } from "../../worker/src/services/clinical";
import { createTestDb } from "./d1";

const NOW = new Date("2026-10-10T12:00:00Z");
const company = (t: string) => allCompanies().find((c) => c.ticker === t)!;
const pad = " Viking Therapeutics is a clinical-stage biopharmaceutical company focused on metabolic and endocrine disorders.".repeat(3);

const SUCCESS_TEXT = `Viking Therapeutics announced positive top-line results from its Phase 2 VENTURE trial of VK2735 in obesity (NCT06068946). The study met its primary endpoint, with patients receiving VK2735 showing statistically significant reductions in body weight compared with placebo.${pad}`;
const EXCERPT = "The study met its primary endpoint, with patients receiving VK2735 showing statistically significant reductions in body weight";

const event = (over: Partial<ClassifiedEvent> = {}): ClassifiedEvent => ({
  category: "phase2_success", trialPhase: "2", portion: null, program: "VK2735", indication: "Obesity", nctId: "NCT06068946", evidenceBasis: "primary_endpoint_met",
  terminationReason: null, summary: "VK2735 met the primary endpoint of the Phase 2 VENTURE trial in obesity.", supportingExcerpt: EXCERPT, eventDate: null, needsHumanReview: false, reviewReason: null, ...over,
});

const filing = (accession: string, over: Partial<FilingRef> = {}): FilingRef => ({ ticker: "VKTX", cik: 1607678, form: "8-K", accession, filingDate: "2026-09-22", primaryDocument: "doc.htm", items: "8.01,9.01", description: "8-K", ...over });

/** EDGAR fake: filings per ticker and text per accession. Counts every call. */
function edgar(filings: FilingRef[], texts: Record<string, string | Error> = {}): EdgarProvider & { lists: number; fetches: string[] } {
  const p = {
    lists: 0,
    fetches: [] as string[],
    async listFilings(c: { ticker: string }) {
      p.lists++;
      return filings.filter((f) => f.ticker === c.ticker);
    },
    async fetchFilingText(ref: { accession: string }) {
      p.fetches.push(ref.accession);
      const t = texts[ref.accession] ?? SUCCESS_TEXT;
      if (t instanceof Error) throw t;
      return t;
    },
  };
  return p;
}

/** Classifier fake: answers from a script keyed by a phrase in the text; counts calls. */
function classifier(script: (text: string) => unknown): Classifier & { calls: number } {
  const c = {
    model: "test-model",
    calls: 0,
    async classify(input: { text: string }) {
      c.calls++;
      const output = script(input.text);
      if (output instanceof Error) throw output;
      return { output, model: "test-model", inputTokens: 1000, outputTokens: 200 };
    },
  };
  return c;
}

const ok = (...events: ClassifiedEvent[]) => ({ events, notQualifyingReason: null });

let db: D1Database;
beforeEach(() => {
  db = createTestDb();
});

async function ingest(deps: ClinicalDeps, now = NOW) {
  await runClinicalCycle(db, deps, { now, step: "discover" });
  return runClinicalCycle(db, deps, { now, step: "process" });
}

describe("text handling", () => {
  it("turns filing HTML into text", () => {
    expect(htmlToText("<html><head><style>p{}</style></head><body><p>Phase&nbsp;3 &amp; more</p><script>x()</script><div>met&#8217;s end&#x2014;point</div></body></html>")).toBe("Phase 3 & more\nmet’s end—point");
  });

  it("matches excerpts regardless of spacing, quote style and case, but not paraphrases", () => {
    const source = "The   trial “met” its primary\nendpoint – a statistically significant result.";
    expect(containsExcerpt(source, 'the trial "met" its primary endpoint - a statistically significant result')).toBe(true);
    expect(containsExcerpt(source, "The trial achieved its primary endpoint with a significant result")).toBe(false);
    expect(containsExcerpt(source, "met")).toBe(false);
  });

  it("flags truncation instead of cutting silently", () => {
    expect(truncate("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
    expect(truncate("abc", 4)).toEqual({ text: "abc", truncated: false });
  });
});

describe("pre-filter", () => {
  it("discards 8-Ks without disclosure items and routine 6-Ks before download", () => {
    expect(prefilterFilingMetadata("8-K", "8.01,9.01", "8-K").pass).toBe(true);
    expect(prefilterFilingMetadata("8-K", "7.01,9.01", "8-K").pass).toBe(true);
    expect(prefilterFilingMetadata("8-K", "2.02,9.01", "8-K")).toMatchObject({ pass: false });
    expect(prefilterFilingMetadata("8-K", "5.07", "8-K")).toMatchObject({ pass: false });
    expect(prefilterFilingMetadata("8-K", "", "8-K").pass).toBe(true);
    expect(prefilterFilingMetadata("6-K", "", "DIRECTOR/PDMR SHAREHOLDING")).toMatchObject({ pass: false });
    expect(prefilterFilingMetadata("6-K", "", "TOTAL VOTING RIGHTS")).toMatchObject({ pass: false });
    expect(prefilterFilingMetadata("6-K", "", "FORM 6-K").pass).toBe(true);
  });

  it("requires a Phase II/III trial and outcome or initiation language", () => {
    expect(prefilterText(SUCCESS_TEXT).pass).toBe(true);
    expect(prefilterText(`The company dosed the first patient in its Phase III study.${pad}`).pass).toBe(true);
    expect(prefilterText(`The first patient has been dosed in the registrational trial.${pad}`).pass).toBe(true);
    expect(prefilterText(`The board declared a quarterly dividend and announced a buyback.${pad}`)).toMatchObject({ pass: false, reason: "No Phase II or Phase III trial mentioned" });
    expect(prefilterText(`Our Phase 2 programme is described on our website.${pad}`)).toMatchObject({ pass: false, reason: "No trial outcome or initiation language" });
    expect(prefilterText("Phase 3 met").pass).toBe(false);
  });
});

describe("classification rules", () => {
  const evaluate = (over: Partial<ClassifiedEvent>, text = SUCCESS_TEXT, p12 = false) => evaluateClassification(event(over), text, p12);

  it("accepts a result whose excerpt is in the source", () => {
    expect(evaluate({})).toMatchObject({ outcome: "event", draft: { category: "phase2_success", phase: "2", nctId: "NCT06068946", evidenceBasis: "primary_endpoint_met" } });
  });

  it("rejects output whose supporting excerpt is absent from the source", () => {
    expect(evaluate({ supportingExcerpt: "The study met all primary and secondary endpoints with high significance" })).toMatchObject({ outcome: "rejected" });
    expect(evaluate({ supportingExcerpt: null })).toMatchObject({ outcome: "rejected" });
  });

  it("drops an NCT number that is not written in the source", () => {
    expect(evaluate({ nctId: "NCT99999999" })).toMatchObject({ outcome: "event", draft: { nctId: null } });
  });

  it("does not treat completion or enrolment as success", () => {
    const text = `The Phase 2 VENTURE trial of VK2735 has completed enrollment and the study is now complete. Top-line data are expected next year.${pad}`;
    const done = evaluate({ evidenceBasis: null, supportingExcerpt: "The Phase 2 VENTURE trial of VK2735 has completed enrollment and the study is now complete." }, text);
    expect(done).toMatchObject({ outcome: "review", draft: { category: null, note: "Success without a stated result" } });
  });

  it("records company-characterised results with that evidence basis", () => {
    const text = `Viking reported positive topline data from the Phase 2 trial of VK2735 in obesity, without disclosing the primary endpoint.${pad}`;
    const r = evaluate({ evidenceBasis: "company_characterised", supportingExcerpt: "Viking reported positive topline data from the Phase 2 trial of VK2735 in obesity", nctId: null }, text);
    expect(r).toMatchObject({ outcome: "event", draft: { category: "phase2_success", evidenceBasis: "company_characterised" } });
  });

  it("excludes Phase I/II by default and includes only its Phase II portion when enabled", () => {
    expect(evaluate({ trialPhase: "1/2", portion: "phase2" })).toMatchObject({ outcome: "excluded", reason: "Phase I/II trials are excluded by configuration" });
    expect(evaluate({ trialPhase: "1/2", portion: "phase2" }, SUCCESS_TEXT, true)).toMatchObject({ outcome: "event", draft: { category: "phase2_success", phase: "1/2" } });
    expect(evaluate({ trialPhase: "1/2", portion: "unclear" }, SUCCESS_TEXT, true)).toMatchObject({ outcome: "excluded" });
    expect(evaluate({ trialPhase: "other" })).toMatchObject({ outcome: "excluded", reason: "Not a Phase II or Phase III trial" });
  });

  it("classifies Phase II/III trials by the portion concerned, and holds unclear ones for review", () => {
    expect(evaluate({ trialPhase: "2/3", portion: "phase2" })).toMatchObject({ outcome: "event", draft: { category: "phase2_success", phase: "2/3" } });
    expect(evaluate({ trialPhase: "2/3", portion: "phase3", category: "phase3_success" })).toMatchObject({ outcome: "event", draft: { category: "phase3_success" } });
    expect(evaluate({ trialPhase: "2/3", portion: "phase3", category: "phase3_initiation", evidenceBasis: "initiation_announced" })).toMatchObject({ outcome: "event", draft: { category: "phase3_initiation" } });
    expect(evaluate({ trialPhase: "2/3", portion: "unclear" })).toMatchObject({ outcome: "review", draft: { category: null } });
    expect(evaluate({ trialPhase: "2/3", portion: "phase3", category: "phase2_success" })).toMatchObject({ outcome: "review" });
  });

  it("holds mismatched or doubtful classifications for review", () => {
    expect(evaluate({ trialPhase: "3" })).toMatchObject({ outcome: "review" });
    expect(evaluate({ needsHumanReview: true, reviewReason: "Endpoint unclear" })).toMatchObject({ outcome: "review", draft: { category: null, note: "Endpoint unclear" } });
    expect(evaluate({ category: null })).toMatchObject({ outcome: "review" });
    expect(evaluate({ program: " " })).toMatchObject({ outcome: "review" });
  });

  it("separates terminations by reason", () => {
    const stop = { category: "phase3_failure" as const, trialPhase: "3" as const, evidenceBasis: "termination" as const };
    expect(evaluate({ ...stop, terminationReason: "futility" })).toMatchObject({ outcome: "event", draft: { category: "phase3_failure", terminationReason: "futility" } });
    expect(evaluate({ ...stop, terminationReason: "safety" })).toMatchObject({ outcome: "event" });
    expect(evaluate({ ...stop, terminationReason: "commercial" })).toMatchObject({ outcome: "excluded", reason: "Terminated for commercial reasons, which is not a clinical failure" });
    expect(evaluate({ ...stop, terminationReason: "administrative" })).toMatchObject({ outcome: "excluded" });
    expect(evaluate({ ...stop, terminationReason: "unknown" })).toMatchObject({ outcome: "review", draft: { category: null, note: "Trial terminated, reason not established" } });
  });
});

describe("registry status changes", () => {
  // Wording taken from real ClinicalTrials.gov records.
  const BUSINESS = "Pfizer has made an internal business decision to not continue this study. This decision was not due to safety concerns or clinical effect reasons or requests from any regulatory authorities.";
  const NOT_SAFETY = "The study was terminated early due to Sponsor and participants may transition into a long-term follow-up study. The decision to terminate the trial was not based on any safety and/or efficacy concerns.";
  const EFFICACY = "The study was prematurely discontinued due to a lack of efficacy in sub-study 1";

  it("reads the stated reason, checking commercial wording before safety and efficacy keywords", () => {
    expect(classifyTerminationReason(BUSINESS)).toBe("commercial");
    expect(classifyTerminationReason(NOT_SAFETY)).toBe("commercial");
    expect(classifyTerminationReason("Sponsor has decided to stop the trial based on strategic decisions")).toBe("commercial");
    expect(classifyTerminationReason("Slow enrollment")).toBe("administrative");
    expect(classifyTerminationReason(EFFICACY)).toBe("futility");
    expect(classifyTerminationReason("Stopped at interim analysis for futility; business priorities unchanged")).toBe("futility");
    expect(classifyTerminationReason("Unacceptable hepatic toxicity")).toBe("safety");
    expect(classifyTerminationReason("")).toBe("unknown");
    expect(classifyTerminationReason(null)).toBe("unknown");
  });

  it("never treats Completed as success", () => {
    expect(registrySignal("ACTIVE_NOT_RECRUITING", "COMPLETED", ["PHASE3"], null)).toEqual({ kind: "none", reason: "Completion is not a result" });
  });

  it("never treats a commercial or administrative termination as failure", () => {
    expect(registrySignal("RECRUITING", "TERMINATED", ["PHASE3"], BUSINESS)).toMatchObject({ kind: "excluded" });
    expect(registrySignal("RECRUITING", "TERMINATED", ["PHASE2"], NOT_SAFETY)).toMatchObject({ kind: "excluded" });
    expect(registrySignal("RECRUITING", "WITHDRAWN", ["PHASE3"], "Funding withdrawn")).toMatchObject({ kind: "excluded" });
  });

  it("keeps terminations with insufficient evidence in review, uncategorised", () => {
    expect(registrySignal("RECRUITING", "TERMINATED", ["PHASE3"], null)).toMatchObject({ kind: "review", category: null, terminationReason: "unknown" });
    expect(registrySignal("RECRUITING", "SUSPENDED", ["PHASE3"], "Unacceptable hepatic toxicity")).toMatchObject({ kind: "review", category: null });
    expect(registrySignal("RECRUITING", "TERMINATED", ["PHASE2", "PHASE3"], EFFICACY)).toMatchObject({ kind: "review", category: null });
  });

  it("proposes, for review only, a failure when the registry states futility or safety", () => {
    expect(registrySignal("RECRUITING", "TERMINATED", ["PHASE3"], EFFICACY)).toMatchObject({ kind: "review", category: "phase3_failure", evidenceBasis: "termination", terminationReason: "futility" });
    expect(registrySignal("RECRUITING", "TERMINATED", ["PHASE2"], "Unacceptable hepatic toxicity")).toMatchObject({ kind: "review", category: "phase2_failure", terminationReason: "safety" });
  });

  it("signals a Phase III start when recruiting begins, and nothing for baselines or unrelated changes", () => {
    expect(registrySignal("NOT_YET_RECRUITING", "RECRUITING", ["PHASE3"], null)).toMatchObject({ kind: "review", category: "phase3_initiation", evidenceBasis: "registry_status" });
    expect(registrySignal("NOT_YET_RECRUITING", "RECRUITING", ["PHASE2", "PHASE3"], null)).toMatchObject({ kind: "review", category: null });
    expect(registrySignal("NOT_YET_RECRUITING", "RECRUITING", ["PHASE2"], null).kind).toBe("none");
    expect(registrySignal(null, "RECRUITING", ["PHASE3"], null).kind).toBe("none");
    expect(registrySignal("RECRUITING", "RECRUITING", ["PHASE3"], null).kind).toBe("none");
    expect(registrySignal("RECRUITING", "ACTIVE_NOT_RECRUITING", ["PHASE3"], null).kind).toBe("none");
  });
});

describe("ingestion pipeline", () => {
  it("discovers filings once, excludes by metadata without download, and classifies each document once", async () => {
    const e = edgar([filing("0001-26-000001"), filing("0001-26-000002", { items: "5.07" }), filing("0001-26-000003", { filingDate: "2026-08-01" })], { "0001-26-000003": `Annual meeting results and a quarterly dividend.${pad}` });
    const c = classifier(() => ok(event()));
    const deps = { edgar: e, classifier: c };

    const first = await runClinicalCycle(db, deps, { now: NOW, step: "discover" });
    expect(first).toMatchObject({ step: "discover", discovered: 3, backlog: 2 });
    expect((await runClinicalCycle(db, deps, { now: NOW, step: "discover" })).discovered).toBe(0);

    const run = await runClinicalCycle(db, deps, { now: NOW, step: "process" });
    expect(run).toMatchObject({ step: "process", processed: 2, backlog: 0, failed: [] });
    expect(e.fetches.sort()).toEqual(["0001-26-000001", "0001-26-000003"]);
    expect(c.calls).toBe(1);

    await runClinicalCycle(db, deps, { now: NOW, step: "process" });
    await runClinicalCycle(db, deps, { now: NOW, step: "discover" });
    await runClinicalCycle(db, deps, { now: NOW, step: "process" });
    expect(c.calls).toBe(1);
    expect(e.fetches).toHaveLength(2);

    const docs = (await db.prepare("SELECT accession, state, state_reason, model, prompt_version, input_tokens FROM documents ORDER BY accession").all<Record<string, unknown>>()).results;
    expect(docs[0]).toMatchObject({ state: "classified", model: "test-model", prompt_version: dashboardConfig.clinical.promptVersion, input_tokens: 1000 });
    expect(docs[1]).toMatchObject({ state: "excluded", state_reason: "8-K items 5.07 are not disclosure items", model: null });
    expect(docs[2]).toMatchObject({ state: "excluded", state_reason: "No Phase II or Phase III trial mentioned" });

    const status = await getClinicalStatus(db, true);
    expect(status).toMatchObject({ documents: { classified: 1, excluded: 2 }, events: { pending: 1 }, inputTokens: 1000, outputTokens: 200 });
  });

  it("chooses to discover first, then work the backlog, then discover again after an hour", async () => {
    const deps = { edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ok(event())) };
    expect((await runClinicalCycle(db, deps, { now: NOW })).step).toBe("discover");
    expect((await runClinicalCycle(db, deps, { now: new Date(NOW.getTime() + 900_000) })).step).toBe("process");
    expect((await runClinicalCycle(db, deps, { now: new Date(NOW.getTime() + 1_800_000) })).step).toBe("discover");
  });

  it("limits each run to the configured batch so one invocation stays within the request budget", async () => {
    const many = Array.from({ length: 25 }, (_, i) => filing(`0001-26-${String(i).padStart(6, "0")}`, { filingDate: `2026-09-${String(i + 1).padStart(2, "0")}` }));
    const e = edgar(many);
    const deps = { edgar: e, classifier: classifier(() => ok(event())) };
    await runClinicalCycle(db, deps, { now: NOW, step: "discover" });
    const run = await runClinicalCycle(db, deps, { now: NOW, step: "process" });
    expect(run.processed).toBe(dashboardConfig.clinical.batchSize);
    expect(run.backlog).toBe(15);
    expect(e.fetches[0]).toBe("0001-26-000024"); // newest first
  });

  it("saves every classified event as pending review, never verified", async () => {
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ok(event())) });
    const rows = (await db.prepare("SELECT status, origin, model FROM events").all()).results;
    expect(rows).toEqual([{ status: "pending", origin: "llm", model: "test-model" }]);
  });

  it("creates no categorised event from output that fails the schema, and queues the document for manual review", async () => {
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ({ events: [{ category: "phase9_miracle" }] })) });
    const pending = await listReviewItems(db, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ category: null, origin: "manual", note: "Classifier output failed schema validation; categorise manually" });
    expect((await getClinicalFeed(db)).items).toEqual([]);
  });

  it("creates no categorised event when the excerpt is not in the source", async () => {
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ok(event({ supportingExcerpt: "VK2735 demonstrated overwhelming efficacy across every endpoint measured" }))) });
    const pending = await listReviewItems(db, "pending");
    expect(pending.map((p) => p.category)).toEqual([null]);
    expect(pending[0]!.note).toContain("supporting excerpt not found");
    expect((await getClinicalFeed(db)).total).toBe(0);
  });

  it("records commercial terminations as excluded with the reason, outside the feed", async () => {
    const text = `The company discontinued its Phase 3 study of VK2735 following a strategic portfolio review; the decision was not related to safety or efficacy.${pad}`;
    const c = classifier(() => ok(event({ category: "phase3_failure", trialPhase: "3", evidenceBasis: "termination", terminationReason: "commercial", supportingExcerpt: "The company discontinued its Phase 3 study of VK2735 following a strategic portfolio review", nctId: null })));
    await ingest({ edgar: edgar([filing("0001-26-000001")], { "0001-26-000001": text }), classifier: c });
    expect(await listReviewItems(db, "pending")).toEqual([]);
    const doc = await db.prepare("SELECT state, state_reason FROM documents").first<{ state: string; state_reason: string }>();
    expect(doc).toEqual({ state: "excluded", state_reason: "excluded: Terminated for commercial reasons, which is not a clinical failure" });
  });

  it("records a document with no qualifying event as excluded", async () => {
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ({ events: [], notQualifyingReason: "Pipeline overview only" })) });
    expect(await db.prepare("SELECT state, state_reason FROM documents").first()).toEqual({ state: "excluded", state_reason: "Pipeline overview only" });
  });

  it("retries a failed classifier request without double-classifying, then gives up", async () => {
    let fail = true;
    const c = classifier(() => (fail ? new UpstreamError("rate_limited", 429) : ok(event())));
    const deps = { edgar: edgar([filing("0001-26-000001")]), classifier: c };
    const run = await ingest(deps);
    expect(run.failed).toHaveLength(1);
    expect(await db.prepare("SELECT state, attempts, state_reason, model FROM documents").first()).toEqual({ state: "fetched", attempts: 1, state_reason: "Classifier request failed (rate_limited)", model: null });
    expect((await getClinicalFeed(db)).lastRefreshFailed).toBe(true);

    fail = false;
    await runClinicalCycle(db, deps, { now: NOW, step: "process" });
    expect(await db.prepare("SELECT state FROM documents").first()).toEqual({ state: "classified" });
    expect((deps.edgar as ReturnType<typeof edgar>).fetches).toHaveLength(1);

    const db2 = createTestDb();
    const always = { edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => new UpstreamError("http", 500)) };
    await runClinicalCycle(db2, always, { now: NOW, step: "discover" });
    for (let i = 0; i < 4; i++) await runClinicalCycle(db2, always, { now: NOW, step: "process" });
    expect(await db2.prepare("SELECT state, attempts FROM documents").first()).toEqual({ state: "error", attempts: 3 });
    expect(always.classifier.calls).toBe(3);
  });

  it("holds documents, and says so, when no classifier is configured", async () => {
    const e = edgar([filing("0001-26-000001")]);
    await ingest({ edgar: e, classifier: null });
    await runClinicalCycle(db, { edgar: e, classifier: null }, { now: NOW, step: "process" });
    expect(e.fetches).toHaveLength(1);
    expect(await db.prepare("SELECT state FROM documents").first()).toEqual({ state: "fetched" });
    expect(await db.prepare("SELECT last_error, failed_count FROM job_status WHERE job = 'clinical'").first()).toEqual({ last_error: "Classifier is not configured", failed_count: 1 });
    expect((await getClinicalFeed(db)).lastRefreshFailed).toBe(true);

    // Once a classifier is available the waiting document is classified without another download.
    await runClinicalCycle(db, { edgar: e, classifier: classifier(() => ok(event())) }, { now: NOW, step: "process" });
    expect(e.fetches).toHaveLength(1);
    expect(await db.prepare("SELECT state FROM documents").first()).toEqual({ state: "classified" });
  });

  it("survives an EDGAR outage for one company and a failed download", async () => {
    const e = edgar([filing("0001-26-000001"), filing("0001-26-000002", { ticker: "MDGL", cik: 1157601 })], { "0001-26-000002": new UpstreamError("timeout") });
    const original = e.listFilings;
    e.listFilings = async (c) => (c.ticker === "LLY" ? Promise.reject(new UpstreamError("http", 503)) : original(c as never));
    const found = await runClinicalCycle(db, { edgar: e, classifier: classifier(() => ok(event())) }, { now: NOW, step: "discover" });
    expect(found).toMatchObject({ discovered: 2, failed: ["LLY"] });
    const run = await runClinicalCycle(db, { edgar: e, classifier: classifier(() => ok(event())) }, { now: NOW, step: "process" });
    expect(run.failed).toEqual(["edgar:0001-26-000002"]);
    expect((await getClinicalFeed(db)).total).toBe(1);
  });

  describe("manual-only mode", () => {
    afterEach(() => void (dashboardConfig.clinical.classificationMode = "llm-with-review"));

    it("queues candidates for manual categorisation without calling a classifier", async () => {
      dashboardConfig.clinical.classificationMode = "manual-only";
      const c = classifier(() => ok(event()));
      await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: c });
      expect(c.calls).toBe(0);
      const pending = await listReviewItems(db, "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ category: null, origin: "manual", note: "Awaiting manual categorisation", model: null });
      expect(pending[0]!.excerpt).toContain("Phase 2 VENTURE");
      expect((await getClinicalFeed(db)).total).toBe(0);
    });
  });
});

describe("deduplication", () => {
  const news = (items: Array<{ link: string; date: string; text?: string }>): NewsProvider => ({ fetchFeed: async () => items.map((i) => ({ title: "Viking announces results", link: i.link, date: i.date, text: i.text ?? SUCCESS_TEXT })) });
  afterEach(() => void (dashboardConfig.news.rssFeeds = []));

  it("treats an 8-K and its matching press release as one event with two sources, SEC filing first", async () => {
    dashboardConfig.news.rssFeeds = [{ ticker: "VKTX", url: "https://ir.example.com/rss" }];
    const c = classifier(() => ok(event()));
    await ingest({ edgar: edgar([filing("0001-26-000001", { filingDate: "2026-09-22" })]), classifier: c, news: news([{ link: "https://ir.example.com/pr/1", date: "2026-09-21" }]) });
    expect(c.calls).toBe(2);

    const feed = await getClinicalFeed(db);
    expect(feed.total).toBe(1);
    const e = feed.items[0]!;
    expect(e.sources.map((s) => s.kind)).toEqual(["edgar", "news"]);
    expect(e.primarySource).toMatchObject({ kind: "edgar", label: "SEC Form 8-K", url: filingUrl(1607678, "0001-26-000001") });
    expect(e.announcementDate).toBe("2026-09-21"); // earliest report
  });

  it("merges without an NCT number when programme and timing match", async () => {
    dashboardConfig.news.rssFeeds = [{ ticker: "VKTX", url: "https://ir.example.com/rss" }];
    let n = 0;
    const c = classifier(() => ok(event({ nctId: n++ === 0 ? "NCT06068946" : null, program: n === 1 ? "VK2735" : "VK-2735" })));
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: c, news: news([{ link: "https://ir.example.com/pr/1", date: "2026-09-23" }]) });
    const feed = await getClinicalFeed(db);
    expect(feed.total).toBe(1);
    expect(feed.items[0]!.nctId).toBe("NCT06068946");
  });

  it("does not create a new event for a later follow-up about the same result", async () => {
    const c = classifier(() => ok(event({ nctId: null })));
    const deps = { edgar: edgar([filing("0001-26-000001", { filingDate: "2026-06-01" }), filing("0001-26-000002", { filingDate: "2026-09-22" })]), classifier: c };
    await ingest(deps);
    const feed = await getClinicalFeed(db);
    expect(feed.total).toBe(1);
    expect(feed.items[0]!.sources).toHaveLength(2);
    expect(feed.items[0]!.announcementDate).toBe("2026-06-01");
  });

  it("keeps different trials, different outcomes and different companies apart", async () => {
    const variants: Record<string, ClassifiedEvent> = {
      "0001-26-000001": event(),
      "0001-26-000002": event({ nctId: null, program: "VK2809", indication: "MASH" }),
      "0001-26-000003": event({ category: "phase3_initiation", trialPhase: "3", evidenceBasis: "initiation_announced", nctId: null }),
    };
    const texts = Object.fromEntries(Object.keys(variants).map((k) => [k, `${SUCCESS_TEXT} ref ${k}`]));
    const c = classifier((text) => ok(variants[text.match(/ref (\S+)/)![1]!]!));
    await ingest({ edgar: edgar([filing("0001-26-000001"), filing("0001-26-000002"), filing("0001-26-000003"), filing("0001-26-000004", { ticker: "MDGL", cik: 1157601 })], { ...texts, "0001-26-000004": `${SUCCESS_TEXT} ref 0001-26-000001` }), classifier: c });
    expect((await getClinicalFeed(db)).total).toBe(4);
  });

  it("does not reopen a rejected event when another report arrives", async () => {
    const c = classifier(() => ok(event()));
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: c });
    const id = (await listReviewItems(db, "pending"))[0]!.id;
    await rejectReview(db, id, "owner@example.com", NOW);
    await ingest({ edgar: edgar([filing("0001-26-000001"), filing("0001-26-000002", { filingDate: "2026-09-25" })]), classifier: c });
    expect((await getClinicalFeed(db)).total).toBe(0);
    expect((await listReviewItems(db, "rejected"))[0]!.sources).toHaveLength(2);
    expect(await listReviewItems(db, "pending")).toEqual([]);
  });

  it("records several events from one document", async () => {
    const second = event({ category: "phase3_initiation", trialPhase: "3", evidenceBasis: "initiation_announced", program: "VK2809", nctId: null });
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ok(event(), second)) });
    expect((await getClinicalFeed(db)).items.map((e) => e.category).sort()).toEqual(["phase2_success", "phase3_initiation"]);
  });
});

describe("visibility and review", () => {
  const review = (over: Partial<ReviewInput> = {}): ReviewInput => ({ category: "phase2_success", phase: "2", program: "VK2735", indication: "Obesity", summary: "VK2735 met the primary endpoint.", evidenceBasis: "primary_endpoint_met", nctId: "NCT06068946", announcementDate: "2026-09-22", ...over });
  afterEach(() => void (dashboardConfig.news.showUnreviewedEvents = true));

  it("decides visibility from status: verified shown, pending only if enabled and flagged, rejected never", () => {
    expect(publicVerification("verified", "phase2_success", false)).toBe("verified");
    expect(publicVerification("pending", "phase2_success", true)).toBe("unreviewed");
    expect(publicVerification("pending", "phase2_success", false)).toBeNull();
    expect(publicVerification("rejected", "phase2_success", true)).toBeNull();
    expect(publicVerification("verified", null, true)).toBeNull();
  });

  it("shows a pending event as Unreviewed, then Verified after confirmation, and removes it when rejected", async () => {
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ok(event())) });
    const id = (await listReviewItems(db, "pending"))[0]!.id;
    expect((await getClinicalFeed(db)).items[0]).toMatchObject({ id, verification: "unreviewed" });

    dashboardConfig.news.showUnreviewedEvents = false;
    expect((await getClinicalFeed(db)).items).toEqual([]);
    expect((await getClinicalFeed(db)).showsUnreviewed).toBe(false);

    const confirmed = await saveReview(db, id, review({ summary: "Corrected summary." }), "owner@example.com", true, NOW);
    expect(confirmed).toMatchObject({ ok: true, item: { status: "verified", summary: "Corrected summary." } });
    expect((await getClinicalFeed(db)).items[0]).toMatchObject({ id, verification: "verified", summary: "Corrected summary." });

    dashboardConfig.news.showUnreviewedEvents = true;
    await rejectReview(db, id, "owner@example.com", NOW);
    expect((await getClinicalFeed(db)).items).toEqual([]);
    expect(await db.prepare("SELECT status, reviewed_by FROM events").first()).toEqual({ status: "rejected", reviewed_by: "owner@example.com" });
  });

  it("lets the reviewer correct fields without verifying, and categorise an uncategorised candidate", async () => {
    await ingest({ edgar: edgar([filing("0001-26-000001")]), classifier: classifier(() => ok(event({ needsHumanReview: true, reviewReason: "Endpoint unclear" }))) });
    const item = (await listReviewItems(db, "pending"))[0]!;
    expect(item.category).toBeNull();
    expect((await getClinicalFeed(db)).total).toBe(0);

    const saved = await saveReview(db, item.id, review({ category: "phase2_failure", evidenceBasis: "primary_endpoint_not_met" }), "owner@example.com", false, NOW);
    expect(saved).toMatchObject({ ok: true, item: { status: "pending", category: "phase2_failure" } });
    expect((await getClinicalFeed(db)).items[0]).toMatchObject({ category: "phase2_failure", verification: "unreviewed" });
    expect(await saveReview(db, "missing", review(), "x", true)).toEqual({ ok: false, reason: "not_found" });
    expect(await rejectReview(db, "missing", "x")).toEqual({ ok: false, reason: "not_found" });
  });

  it("validates review input", () => {
    expect(parseReviewInput(review())).toMatchObject({ ok: true });
    expect(parseReviewInput(review({ phase: "" as never, indication: "", nctId: "", eventDate: "" }))).toMatchObject({ ok: true, value: { phase: null, indication: null, nctId: null, eventDate: null } });
    const bad = parseReviewInput({ category: "phase4_success", program: "", summary: "", evidenceBasis: "vibes", announcementDate: "2026-02-30", nctId: "NCT1" });
    expect(Object.keys((bad as { fields: object }).fields).sort()).toEqual(["announcementDate", "category", "evidenceBasis", "nctId", "program", "summary"]);
  });

  it("sorts newest first, filters by category and pages", async () => {
    const dates = ["2026-03-01", "2026-09-01", "2026-06-01"];
    const filings = dates.map((d, i) => filing(`0001-26-00000${i}`, { filingDate: d }));
    const texts = Object.fromEntries(filings.map((f, i) => [f.accession, `${SUCCESS_TEXT} ref ${i}`]));
    const c = classifier((text) => {
      const i = Number(text.match(/ref (\d)/)![1]);
      return ok(i === 1 ? event({ category: "phase3_initiation", trialPhase: "3", evidenceBasis: "initiation_announced", program: "VK2809", nctId: null }) : event({ program: `Drug${i}`, nctId: null, indication: `Indication ${i}` }));
    });
    await ingest({ edgar: edgar(filings, texts), classifier: c });

    const all = await getClinicalFeed(db);
    expect(all.items.map((e) => e.announcementDate)).toEqual(["2026-09-01", "2026-06-01", "2026-03-01"]);
    expect((await getClinicalFeed(db, { category: "phase3_initiation" })).items.map((e) => e.program)).toEqual(["VK2809"]);
    expect((await getClinicalFeed(db, { category: "phase3_failure" })).items).toEqual([]);

    const page1 = await getClinicalFeed(db, { limit: 2 });
    expect(page1).toMatchObject({ total: 3, nextOffset: 2 });
    const page2 = await getClinicalFeed(db, { limit: 2, offset: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextOffset).toBeNull();
  });

  it("keeps the announcement date separate from the retrieval time", async () => {
    await ingest({ edgar: edgar([filing("0001-26-000001", { filingDate: "2026-09-22" })]), classifier: classifier(() => ok(event({ eventDate: "2026-09-20" }))) });
    expect((await getClinicalFeed(db)).items[0]).toMatchObject({ announcementDate: "2026-09-22", eventDate: "2026-09-20", lastRetrievedAt: Math.floor(NOW.getTime() / 1000) });
  });
});

describe("registry signals", () => {
  const update = (over: Partial<TrialStatusUpdate>): TrialStatusUpdate => ({ ticker: "MDGL", nctId: "NCT00000101", title: "A Phase 3 Study", phases: ["PHASE3"], overallStatus: "NOT_YET_RECRUITING", whyStopped: null, conditions: ["MASH"], interventions: ["Resmetirom"], ...over });
  const provider = (updates: TrialStatusUpdate[], down: string[] = []): TrialStatusProvider => ({
    async fetchStatusUpdates(c) {
      if (down.includes(c.ticker)) throw new UpstreamError("timeout");
      return updates.filter((u) => u.ticker === c.ticker);
    },
  });

  it("records a baseline first, then turns a recruiting start into a pending initiation for review", async () => {
    expect((await syncTrialSignals(db, provider([update({})]), { now: NOW })).updated).toBe(0);
    const r = await syncTrialSignals(db, provider([update({ overallStatus: "RECRUITING" })]), { now: NOW });
    expect(r.updated).toBe(1);
    const item = (await listReviewItems(db, "pending"))[0]!;
    expect(item).toMatchObject({ category: "phase3_initiation", evidenceBasis: "registry_status", origin: "registry", status: "pending", nctId: "NCT00000101", program: "Resmetirom", phase: "3" });
    expect((await getClinicalFeed(db)).items[0]).toMatchObject({ verification: "unreviewed", primarySource: { kind: "registry" } });
    expect((await syncTrialSignals(db, provider([update({ overallStatus: "RECRUITING" })]), { now: NOW })).updated).toBe(0);
  });

  it("attaches the registry change to an initiation already reported in a filing", async () => {
    const text = `Madrigal dosed the first patient in its Phase 3 study of resmetirom in MASH (NCT00000101).${pad}`;
    const c = classifier(() => ok(event({ category: "phase3_initiation", trialPhase: "3", evidenceBasis: "initiation_announced", program: "Resmetirom", indication: "MASH", nctId: "NCT00000101", supportingExcerpt: "Madrigal dosed the first patient in its Phase 3 study of resmetirom in MASH" })));
    await ingest({ edgar: edgar([filing("0001-26-000001", { ticker: "MDGL", cik: 1157601 })], { "0001-26-000001": text }), classifier: c });
    await syncTrialSignals(db, provider([update({})]), { now: NOW });
    await syncTrialSignals(db, provider([update({ overallStatus: "RECRUITING" })]), { now: NOW });
    const feed = await getClinicalFeed(db);
    expect(feed.total).toBe(1);
    expect(feed.items[0]!.sources.map((s) => s.kind)).toEqual(["edgar", "registry"]);
    expect(feed.items[0]!.evidenceBasis).toBe("initiation_announced");
  });

  it("creates nothing for Completed, and only an excluded record for a commercial termination", async () => {
    const trials = [update({ nctId: "NCT00000201", overallStatus: "RECRUITING" }), update({ nctId: "NCT00000202", overallStatus: "RECRUITING" })];
    await syncTrialSignals(db, provider(trials), { now: NOW });
    await syncTrialSignals(db, provider([update({ nctId: "NCT00000201", overallStatus: "COMPLETED" }), update({ nctId: "NCT00000202", overallStatus: "TERMINATED", whyStopped: "Business decision" })]), { now: NOW });
    expect(await listReviewItems(db, "pending")).toEqual([]);
    expect((await getClinicalFeed(db)).total).toBe(0);
    const docs = (await db.prepare("SELECT id, state, state_reason FROM documents").all<Record<string, string>>()).results;
    expect(docs).toEqual([{ id: "registry:NCT00000202:TERMINATED", state: "excluded", state_reason: "TERMINATED for commercial reasons: Business decision" }]);
  });

  it("holds an unexplained termination for review, uncategorised and out of the public feed", async () => {
    await syncTrialSignals(db, provider([update({ overallStatus: "RECRUITING" })]), { now: NOW });
    await syncTrialSignals(db, provider([update({ overallStatus: "TERMINATED" })]), { now: NOW });
    const item = (await listReviewItems(db, "pending"))[0]!;
    expect(item).toMatchObject({ category: null, terminationReason: "unknown" });
    expect(item.note).toContain("insufficient");
    expect((await getClinicalFeed(db)).total).toBe(0);
  });

  it("reports a failed company without losing the others", async () => {
    const r = await syncTrialSignals(db, provider([update({})], ["LLY"]), { now: NOW });
    expect(r.failed).toEqual(["LLY"]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM trial_status").first()).toEqual({ n: 1 });
  });
});

describe("source providers", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const UA = "example.com dashboard (admin@example.com)";

  it("lists only the company's disclosure form within the window and sends the SEC User-Agent", async () => {
    const recent = {
      accessionNumber: ["a-1", "a-2", "a-3", "a-4"], filingDate: ["2026-09-22", "2026-09-01", "2026-08-01", "2025-01-01"], form: ["8-K", "10-Q", "8-K/A", "8-K"],
      primaryDocument: ["one.htm", "q.htm", "three.htm", "old.htm"], items: ["8.01,9.01", "", "7.01", "8.01"], primaryDocDescription: ["8-K", "10-Q", "8-K/A", "8-K"],
    };
    const fetchImpl = vi.fn().mockResolvedValue(json({ filings: { recent } }));
    const out = await createEdgarProvider(UA, { fetchImpl }).listFilings(company("VKTX"), "2025-10-10");
    expect(out.map((f) => `${f.form} ${f.accession}`)).toEqual(["8-K a-1", "8-K/A a-3"]);
    expect(out[0]).toMatchObject({ ticker: "VKTX", cik: 1607678, items: "8.01,9.01", primaryDocument: "one.htm" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://data.sec.gov/submissions/CIK0001607678.json");
    expect(init.headers["User-Agent"]).toBe(UA);
  });

  it("refuses to call EDGAR without a User-Agent carrying a contact address", async () => {
    const fetchImpl = vi.fn();
    await expect(createEdgarProvider(undefined, { fetchImpl }).listFilings(company("ARGX"), "2025-10-10")).rejects.toMatchObject({ kind: "config" });
    await expect(createEdgarProvider("my dashboard", { fetchImpl }).fetchFilingText({ cik: 1, accession: "a-1", primaryDocument: "x.htm" })).rejects.toMatchObject({ kind: "config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the main document and the press-release exhibit of a filing", async () => {
    expect(pickDocuments(["R1.htm", "vktx-20260922.htm", "vktx-ex99_1.htm", "vktx-ex99_2.htm", "img.jpg"], "vktx-20260922.htm")).toEqual(["vktx-20260922.htm", "vktx-ex99_1.htm"]);
    expect(pickDocuments(["f6k_100526.htm", "logo.jpg"], "f6k_100526.htm")).toEqual(["f6k_100526.htm"]);
    const pages: Record<string, Response> = {
      "index.json": json({ directory: { item: [{ name: "main.htm" }, { name: "d1ex991.htm" }] } }),
      "main.htm": new Response("<p>Item 8.01 Other Events</p>"),
      "d1ex991.htm": new Response("<p>Phase 3 trial met its primary endpoint</p>"),
    };
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => pages[url.split("/").pop()!]!.clone());
    const text = await createEdgarProvider(UA, { fetchImpl }).fetchFilingText({ cik: 1607678, accession: "0001193125-26-397219", primaryDocument: "main.htm" });
    expect(text).toBe("Item 8.01 Other Events\n\nPhase 3 trial met its primary endpoint");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://www.sec.gov/Archives/edgar/data/1607678/000119312526397219/index.json");
    expect(filingUrl(1607678, "0001193125-26-397219")).toBe("https://www.sec.gov/Archives/edgar/data/1607678/000119312526397219/0001193125-26-397219-index.htm");
  });

  it("parses RSS and Atom feeds and skips malformed items", () => {
    const rss = `<rss><channel>
      <item><title><![CDATA[Results &amp; more]]></title><link>https://ir.example.com/1</link><pubDate>Tue, 22 Sep 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Phase 3 <b>met</b> its endpoint</p>]]></description></item>
      <item><title>No link</title></item>
      <item><title>Bad link</title><link>javascript:alert(1)</link></item>
    </channel></rss>`;
    expect(parseFeed(rss)).toEqual([{ title: "Results & more", link: "https://ir.example.com/1", date: "2026-09-22", text: "Results & more\n\nPhase 3 met its endpoint" }]);
    const atom = `<feed><entry><title>Start</title><link href="https://ir.example.com/2"/><updated>2026-09-23T08:00:00Z</updated><summary>First patient dosed</summary></entry></feed>`;
    expect(parseFeed(atom)).toMatchObject([{ link: "https://ir.example.com/2", date: "2026-09-23" }]);
    expect(parseFeed("not xml")).toEqual([]);
  });

  it("calls Claude with the configured model and structured output, and returns usage", async () => {
    const parse = vi.fn().mockResolvedValue({ stop_reason: "end_turn", parsed_output: ok(event()), model: "claude-opus-5-5", usage: { input_tokens: 9000, output_tokens: 700 } });
    const c = createAnthropicClassifier(undefined, { client: { beta: { messages: { parse } } } as never })!;
    const out = await c.classify({ ticker: "VKTX", companyName: "Viking Therapeutics", aliases: ["Viking"], sourceLabel: "SEC Form 8-K", publishedDate: "2026-09-22", text: SUCCESS_TEXT });
    expect(out).toMatchObject({ model: "claude-opus-5-5", inputTokens: 9000, outputTokens: 700 });
    const request = parse.mock.calls[0]![0];
    expect(request).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(request.output_config.effort).toBe("medium");
    expect(request.output_config.format).toBeTruthy();
    expect(request.messages[0].content).toContain(SUCCESS_TEXT);
    expect(request.system).toContain("exactly five event categories");
  });

  it("treats a refusal or cut-off response as a failed request, and is absent without a key", async () => {
    for (const stop_reason of ["refusal", "max_tokens"]) {
      const parse = vi.fn().mockResolvedValue({ stop_reason, parsed_output: null, model: "m", usage: { input_tokens: 1, output_tokens: 1 } });
      const c = createAnthropicClassifier(undefined, { client: { beta: { messages: { parse } } } as never })!;
      await expect(c.classify({ ticker: "VKTX", companyName: "V", aliases: [], sourceLabel: "x", publishedDate: "2026-09-22", text: "t" })).rejects.toMatchObject({ kind: "invalid" });
    }
    expect(createAnthropicClassifier(undefined)).toBeNull();
  });
});

describe("clinical API", () => {
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
    app = createApp({ auth: { getKey }, clinical: () => ({ edgar: edgar([filing("0001-26-000001"), filing("0001-26-000002", { filingDate: "2026-08-01" })], { "0001-26-000002": `${SUCCESS_TEXT} second` }), classifier: classifier((t) => (t.includes("second") ? ok(event({ needsHumanReview: true, reviewReason: "INTERNAL-REVIEW-NOTE" })) : ok(event()))) }) });
  });

  beforeEach(() => {
    resetRateLimits();
    env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud", ADMIN_EMAILS: "owner@example.com", ALLOWED_ORIGINS: ORIGIN };
  });

  const headers = (auth: boolean) => ({ ...(auth ? { "Cf-Access-Jwt-Assertion": token } : {}), Origin: ORIGIN, "X-Biotech-Admin": "1", "Content-Type": "application/json" });
  const call = (auth: boolean, path: string, method = "GET", body?: unknown) => app.request(`${API}${path}`, { method, headers: headers(auth), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const fill = async () => {
    await call(true, "/admin/refresh/clinical", "POST", { step: "discover" });
    return (await call(true, "/admin/refresh/clinical", "POST", { step: "process" })).json();
  };
  const body = { category: "phase2_success", phase: "2", program: "VK2735", summary: "Reviewed.", evidenceBasis: "primary_endpoint_met", announcementDate: "2026-09-22" };

  it("runs ingestion for the administrator and exposes the review queue only to them", async () => {
    expect(await fill()).toMatchObject({ step: "process", processed: 2, backlog: 0 });
    const queue = (await (await call(true, "/admin/review")).json()) as { items: ReviewItem[] };
    expect(queue.items).toHaveLength(2);
    expect(queue.items.map((i) => i.category).sort()).toEqual([null, "phase2_success"].sort());
    expect(queue.items.find((i) => i.category)!.excerpt).toContain("met its primary endpoint");
    expect((await call(true, "/admin/clinical/status")).status).toBe(200);
  });

  it("never lets a visitor read pending, uncategorised or rejected items, or review-only fields", async () => {
    await fill();
    for (const path of ["/admin/review", "/admin/review?status=rejected", "/admin/review?status=pending", "/admin/clinical/status"]) expect((await call(false, path)).status, path).toBe(401);
    for (const [path, method] of [["/admin/review/x", "PUT"], ["/admin/review/x/confirm", "POST"], ["/admin/review/x/reject", "POST"], ["/admin/refresh/clinical", "POST"], ["/admin/refresh/signals", "POST"]] as const) {
      expect((await call(false, path, method, body)).status, `${method} ${path}`).toBe(401);
    }

    const text = await (await call(false, "/v1/events")).text();
    const feed = JSON.parse(text) as ClinicalFeed;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.verification).toBe("unreviewed");
    expect(text).not.toMatch(/INTERNAL-REVIEW-NOTE|excerpt|"note"|"model"|promptVersion|reviewedAt|reviewedBy|terminationReason|"status"/);

    const id = feed.items[0]!.id;
    expect((await call(true, `/admin/review/${id}/reject`, "POST")).status).toBe(200);
    expect(((await (await call(false, "/v1/events")).json()) as ClinicalFeed).items).toEqual([]);
    for (const method of ["POST", "PUT", "DELETE"]) expect((await call(false, "/v1/events", method)).status).toBe(404);
  });

  it("verifies an event only through an authenticated confirmation", async () => {
    await fill();
    const id = ((await (await call(false, "/v1/events")).json()) as ClinicalFeed).items[0]!.id;
    expect((await call(false, `/admin/review/${id}/confirm`, "POST", body)).status).toBe(401);
    expect(((await (await call(false, "/v1/events")).json()) as ClinicalFeed).items[0]!.verification).toBe("unreviewed");

    expect((await call(true, `/admin/review/${id}/confirm`, "POST", { ...body, category: "nope" })).status).toBe(400);
    expect((await call(true, `/admin/review/${id}`, "PUT", { ...body, summary: "Edited only." })).status).toBe(200);
    expect(((await (await call(false, "/v1/events")).json()) as ClinicalFeed).items[0]).toMatchObject({ verification: "unreviewed", summary: "Edited only." });

    expect((await call(true, `/admin/review/${id}/confirm`, "POST", body)).status).toBe(200);
    expect(((await (await call(false, "/v1/events")).json()) as ClinicalFeed).items[0]).toMatchObject({ verification: "verified", summary: "Reviewed." });
    expect((await call(true, "/admin/review/unknown/confirm", "POST", body)).status).toBe(404);
    const audit = (await db.prepare("SELECT action FROM audit_log WHERE action LIKE 'review.%' ORDER BY id").all<{ action: string }>()).results.map((r) => r.action);
    expect(audit).toEqual(["review.edit", "review.confirm"]);
  });

  it("validates feed query parameters", async () => {
    expect((await call(false, "/v1/events?category=phase3_success")).status).toBe(200);
    expect((await call(false, "/v1/events?category=everything")).status).toBe(400);
    expect((await call(true, "/admin/review?status=secret")).status).toBe(400);
    const empty = (await (await call(false, "/v1/events?offset=abc&limit=-1")).json()) as ClinicalFeed;
    expect(empty).toMatchObject({ items: [], total: 0, nextOffset: null, lastSuccessAt: null });
  });
});
