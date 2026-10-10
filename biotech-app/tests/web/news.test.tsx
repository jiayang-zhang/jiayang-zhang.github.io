// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClinicalEvent, ClinicalFeed, EventCategory, ReviewItem } from "../../shared/events";
import { ApiError, type Api, type ClinicalStatus } from "../../web/src/api";
import { CatalystModule } from "../../web/src/components/CatalystModule";
import { ModuleBoundary } from "../../web/src/components/ModuleCard";
import { NewsModule } from "../../web/src/components/NewsModule";
import { ReviewQueue, validateReview } from "../../web/src/components/ReviewQueue";
import { StockModule } from "../../web/src/components/StockModule";

afterEach(cleanup);
const nowS = Math.floor(Date.now() / 1000);

const ev = (over: Partial<ClinicalEvent>): ClinicalEvent => ({
  id: "e1", ticker: "VKTX", category: "phase2_success", phase: "2", program: "VK2735", indication: "Obesity", summary: "VK2735 met the primary endpoint of the Phase 2 VENTURE trial.",
  evidenceBasis: "primary_endpoint_met", nctId: "NCT06068946", announcementDate: "2026-09-22", eventDate: null, verification: "verified", lastRetrievedAt: nowS,
  primarySource: { kind: "edgar", url: "https://www.sec.gov/Archives/x-index.htm", label: "SEC Form 8-K", date: "2026-09-22" },
  sources: [{ kind: "edgar", url: "https://www.sec.gov/Archives/x-index.htm", label: "SEC Form 8-K", date: "2026-09-22" }, { kind: "news", url: "https://ir.example.com/pr", label: "Press release", date: "2026-09-22" }], ...over,
});
const feed = (items: ClinicalEvent[], over: Partial<ClinicalFeed> = {}): ClinicalFeed => ({ items, total: items.length, nextOffset: null, showsUnreviewed: true, lastSuccessAt: nowS, lastAttemptAt: nowS, lastRefreshFailed: false, ...over });
const fakeApi = (over: Partial<Api>): Api => ({ loginUrl: () => "", ...over }) as Api;
const card = (id: string) => document.querySelector(`.bt-event[data-id="${id}"]`)!;
const ids = () => [...document.querySelectorAll(".bt-event")].map((li) => li.getAttribute("data-id"));

const SAMPLE = [
  ev({ id: "ok" }),
  ev({ id: "fail", ticker: "LLY", category: "phase3_failure", phase: "3", program: "Drug X", evidenceBasis: "company_characterised", verification: "unreviewed", nctId: null, eventDate: "2026-09-18", announcementDate: "2026-09-20" }),
  ev({ id: "start", ticker: "MDGL", category: "phase3_initiation", phase: "3", program: "Resmetirom", evidenceBasis: "initiation_announced", announcementDate: "2026-09-10", sources: [], primarySource: null }),
];

describe("clinical trial feed", () => {
  it("shows every card field: dates, company, category, programme, evidence basis, sources and status", async () => {
    render(<NewsModule api={fakeApi({ events: async () => feed(SAMPLE) })} />);
    await screen.findByText("Drug X");
    expect(ids()).toEqual(["ok", "fail", "start"]);

    const ok = card("ok");
    const text = ok.textContent!;
    for (const part of ["Sep 22, 2026", "VKTX", "Viking Therapeutics", "(Biotech)", "Phase II success", "Verified", "VK2735", "Obesity", "(Phase II)", "met the primary endpoint of the Phase 2 VENTURE trial", "Evidence: Primary endpoint met", "Retrieved"]) expect(text, part).toContain(part);
    const links = [...ok.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([["SEC Form 8-K", "https://www.sec.gov/Archives/x-index.htm"], ["Press release", "https://ir.example.com/pr"], ["NCT06068946", "https://clinicaltrials.gov/study/NCT06068946"]]);
    expect(text).not.toContain("Unreviewed");
    expect(text).not.toContain("Event date");
    expect(screen.getByText(/Last successful update:/)).toBeTruthy();
  });

  it("never presents an unreviewed event as verified, and labels company-characterised evidence", async () => {
    render(<NewsModule api={fakeApi({ events: async () => feed(SAMPLE) })} />);
    await screen.findByText("Drug X");
    const text = card("fail").textContent!;
    expect(text).toContain("Unreviewed");
    expect(text).not.toContain("Verified");
    expect(text).toContain("Phase III failure");
    expect(text).toContain("Evidence: Company-characterised");
    expect(text).toContain("Event date Sep 18, 2026");
    expect(text).toContain("(Pharmaceutical)");
    expect(screen.getByText(/Events marked Unreviewed were classified automatically/)).toBeTruthy();
  });

  it("uses distinct styling and symbols for success, failure and initiation", async () => {
    render(<NewsModule api={fakeApi({ events: async () => feed(SAMPLE) })} />);
    await screen.findByText("Drug X");
    expect(card("ok").className).toContain("bt-event--success");
    expect(card("fail").className).toContain("bt-event--failure");
    expect(card("start").className).toContain("bt-event--initiation");
    expect(card("ok").querySelector(".bt-tone--success")!.textContent).toBe("✓ Phase II success");
    expect(card("fail").querySelector(".bt-tone--failure")!.textContent).toBe("✕ Phase III failure");
    expect(card("start").textContent).toContain("Source: not available");
  });

  it("offers a filter for each of the five categories and All, and asks the server for that category", async () => {
    const events = vi.fn(async (category: EventCategory | null) => feed(SAMPLE.filter((e) => !category || e.category === category)));
    render(<NewsModule api={fakeApi({ events })} />);
    await screen.findByText("Drug X");
    const chips = [...document.querySelectorAll("#bt-news-body .bt-filters button")].map((b) => b.textContent!.replace(/^[^A-Za-z]+/, ""));
    expect(chips).toEqual(["All", "Phase II success", "Phase II failure", "Phase III initiation", "Phase III success", "Phase III failure"]);

    fireEvent.click(screen.getByRole("button", { name: /Phase III failure/ }));
    await waitFor(() => expect(ids()).toEqual(["fail"]));
    expect(events).toHaveBeenLastCalledWith("phase3_failure", 0);

    fireEvent.click(screen.getByRole("button", { name: /Phase II failure/ }));
    await screen.findByText("No events in this category.");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(ids()).toHaveLength(3));
    expect(events).toHaveBeenLastCalledWith(null, 0);
  });

  it("loads more pages without duplicating events", async () => {
    const first = Array.from({ length: 20 }, (_, i) => ev({ id: `a${i}`, program: `P${i}` }));
    const second = [ev({ id: "a19", program: "P19" }), ev({ id: "b0", program: "Last" })];
    const events = vi.fn(async (_c: EventCategory | null, offset: number) => (offset === 0 ? feed(first, { total: 21, nextOffset: 20 }) : feed(second, { total: 21, nextOffset: null })));
    render(<NewsModule api={fakeApi({ events })} />);
    await screen.findByText("P0");
    expect(ids()).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: /Load more \(1 remaining\)/ }));
    await screen.findByText("Last");
    expect(ids()).toHaveLength(21);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("shows empty, stale and error states", async () => {
    render(<NewsModule api={fakeApi({ events: async () => feed([], { lastRefreshFailed: true, lastSuccessAt: null }) })} />);
    await screen.findByText("No clinical events recorded yet.");
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText(/Last successful update: never/)).toBeTruthy();
    cleanup();
    const events = vi.fn().mockRejectedValueOnce(new ApiError(500)).mockResolvedValueOnce(feed(SAMPLE));
    render(<NewsModule api={fakeApi({ events })} />);
    await screen.findByText("The clinical trial feed is unavailable right now.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Drug X");
  });

  it("fails alone: a feed outage leaves the stock table and calendar working, and the reverse", async () => {
    const snapshot = { source: "live", generatedAt: nowS, marketOpen: false, lastSuccessAt: nowS, lastAttemptAt: nowS, lastRefreshFailed: false, benchmarks: [], companies: [{ ticker: "LLY", name: "Eli Lilly", category: "pharma", isBenchmark: false, benchmarkTicker: "PPH", price: 800, prevClose: 790, changePct: 1.27, relativePp: 0.5, sparkline: null, marketCap: 7e11, quoteTime: nowS, fetchedAt: nowS, stale: false }] };
    const calendar = { today: "2026-10-10", lookAheadDays: 90, lastSuccessAt: nowS, lastAttemptAt: nowS, lastRefreshFailed: false, items: [] };
    const all = (api: Api) => (
      <div>
        <ModuleBoundary name="Stock Performance"><StockModule api={api} /></ModuleBoundary>
        <ModuleBoundary name="Catalyst Calendar"><CatalystModule api={api} /></ModuleBoundary>
        <ModuleBoundary name="Clinical Trial Feed"><NewsModule api={api} /></ModuleBoundary>
      </div>
    );
    render(all(fakeApi({ market: async () => snapshot as never, catalysts: async () => calendar as never, events: vi.fn().mockRejectedValue(new ApiError(503)) })));
    await screen.findByText("The clinical trial feed is unavailable right now.");
    await screen.findByRole("table");
    await screen.findByText("No catalysts in the next 90 days.");
    cleanup();

    render(all(fakeApi({ market: vi.fn().mockRejectedValue(new ApiError(502)), catalysts: vi.fn().mockRejectedValue(new ApiError(502)), events: async () => feed(SAMPLE) })));
    await screen.findByText("Market data is unavailable right now.");
    await screen.findByText("The catalyst calendar is unavailable right now.");
    await screen.findByText("Drug X");
  });
});

describe("admin review queue", () => {
  const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
    id: "r1", ticker: "VKTX", category: "phase2_success", phase: "2", program: "VK2735", indication: "Obesity", summary: "VK2735 met the primary endpoint.", evidenceBasis: "primary_endpoint_met",
    nctId: "NCT06068946", announcementDate: "2026-09-22", eventDate: null, status: "pending", excerpt: "The study met its primary endpoint", note: null, terminationReason: null, origin: "llm",
    model: "claude-opus-5-5", promptVersion: "2026-10-11.1", truncated: false, lastRetrievedAt: nowS, reviewedAt: null, sources: [{ kind: "edgar", url: "https://www.sec.gov/x", label: "SEC Form 8-K", date: "2026-09-22" }], ...over,
  });
  const status = (over: Partial<ClinicalStatus> = {}): ClinicalStatus => ({ mode: "llm-with-review", model: "claude-opus-5-5", promptVersion: "2026-10-11.1", classifierConfigured: true, documents: { discovered: 12, fetched: 3, classified: 40, excluded: 600 }, events: { pending: 2, verified: 5 }, inputTokens: 250000, outputTokens: 30000, ...over });
  const api = (over: Partial<Api>, items: ReviewItem[] = [item()]) => fakeApi({ reviewQueue: vi.fn().mockResolvedValue({ items }), clinicalStatus: vi.fn().mockResolvedValue(status()), ...over });

  it("shows the evidence for each item: excerpt, source, model, note and truncation warning", async () => {
    render(<ReviewQueue api={api({}, [item({ note: "Endpoint unclear", truncated: true, category: null })])} />);
    await screen.findByText("The study met its primary endpoint");
    const text = document.querySelector(".bt-review")!.textContent!;
    for (const part of ["Uncategorised", "Classified by claude-opus-5-5", "Source truncated", "Note: Endpoint unclear", "SEC Form 8-K (2026-09-22)", "Prompt 2026-10-11.1"]) expect(text, part).toContain(part);
    expect(screen.getByText(/15 documents waiting, 40 classified, 600 excluded/)).toBeTruthy();
    expect(screen.getByText(/250,000 input and 30,000 output tokens/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pending review (2)" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("confirms an item with corrected fields", async () => {
    const confirmReview = vi.fn().mockResolvedValue(item({ status: "verified" }));
    render(<ReviewQueue api={api({ confirmReview })} />);
    const summary = (await screen.findByLabelText(/One-sentence summary/)) as HTMLTextAreaElement;
    summary.value = "Corrected.";
    fireEvent.input(summary);
    fireEvent.click(screen.getByRole("button", { name: "Confirm VKTX VK2735 as verified" }));
    await screen.findByText("VKTX VK2735: verified.");
    expect(confirmReview).toHaveBeenCalledWith("r1", expect.objectContaining({ category: "phase2_success", summary: "Corrected.", evidenceBasis: "primary_endpoint_met", announcementDate: "2026-09-22" }));
  });

  it("will not confirm an uncategorised item until a category is chosen", async () => {
    const confirmReview = vi.fn().mockResolvedValue(item());
    render(<ReviewQueue api={api({ confirmReview }, [item({ category: null, evidenceBasis: null, summary: null, program: null })])} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm VKTX candidate as verified" }));
    expect(screen.getAllByText("Required")).toHaveLength(4);
    expect(confirmReview).not.toHaveBeenCalled();
    expect(validateReview({ category: "phase3_success", phase: "", program: "X", indication: "", summary: "S", evidenceBasis: "primary_endpoint_met", nctId: "bad", announcementDate: "2026-02-30", eventDate: "" })).toEqual({ announcementDate: "Use a real date in YYYY-MM-DD format", nctId: "Format: NCT followed by 8 digits" });
  });

  it("saves edits without verifying, and rejects", async () => {
    const saveReview = vi.fn().mockResolvedValue(item());
    const rejectReview = vi.fn().mockResolvedValue(item({ status: "rejected" }));
    render(<ReviewQueue api={api({ saveReview, rejectReview })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save edits to VKTX VK2735" }));
    await screen.findByText("VKTX VK2735: changes saved, still pending.");
    fireEvent.click(screen.getByRole("button", { name: "Reject VKTX VK2735" }));
    await screen.findByText("VKTX VK2735: rejected.");
    expect(saveReview).toHaveBeenCalledTimes(1);
    expect(rejectReview).toHaveBeenCalledWith("r1");
  });

  it("switches between pending, verified and rejected lists", async () => {
    const reviewQueue = vi.fn(async (s: string) => ({ items: s === "rejected" ? [item({ id: "x", status: "rejected", program: "Rejected one" })] : [item()] }));
    render(<ReviewQueue api={api({ reviewQueue: reviewQueue as never })} />);
    await screen.findByText("The study met its primary endpoint");
    fireEvent.click(screen.getByRole("button", { name: /^Rejected/ }));
    await screen.findByRole("button", { name: "Confirm VKTX Rejected one as verified" });
    expect(screen.queryByRole("button", { name: "Reject VKTX Rejected one" })).toBeNull();
    expect(reviewQueue).toHaveBeenLastCalledWith("rejected");
  });

  it("warns when no classifier key is set, runs ingestion steps and reports server errors honestly", async () => {
    const refreshClinical = vi.fn().mockResolvedValue({ ran: true, updated: 10, failed: ["a"], backlog: 5 });
    const confirmReview = vi.fn().mockRejectedValue(new ApiError(400, { summary: "At most 600 characters" }));
    render(<ReviewQueue api={api({ refreshClinical, confirmReview, clinicalStatus: vi.fn().mockResolvedValue(status({ classifierConfigured: false })) })} />);
    await screen.findByText(/No classifier key is configured/);
    fireEvent.click(screen.getByRole("button", { name: "Process next batch" }));
    await screen.findByText("10 handled, 1 failed, 5 waiting.");
    expect(refreshClinical).toHaveBeenCalledWith("process");

    fireEvent.click(screen.getByRole("button", { name: "Confirm VKTX VK2735 as verified" }));
    await screen.findByText("At most 600 characters");
    expect(screen.getByText("Please correct the highlighted fields.")).toBeTruthy();
    expect(screen.queryByText(/: verified\./)).toBeNull();
  });
});
