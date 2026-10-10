// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminCatalyst, Catalyst, CatalystFeed } from "../../shared/types";
import { ApiError, type Api } from "../../web/src/api";
import { CatalystAdmin, validateForm } from "../../web/src/components/CatalystAdmin";
import { CatalystModule } from "../../web/src/components/CatalystModule";
import { ModuleBoundary } from "../../web/src/components/ModuleCard";
import { StockModule } from "../../web/src/components/StockModule";

afterEach(cleanup);

const TODAY = "2026-10-10";
const nowS = Math.floor(Date.now() / 1000);

const item = (over: Partial<Catalyst>): Catalyst => ({
  id: "x", ticker: "MDGL", program: "Rezdiffra", indication: "MASH", eventType: "pdufa", dateStart: "2026-11-20", dateEnd: null, status: "confirmed",
  origin: "manual", nctId: null, phase: null, sourceUrl: "https://example.com/pr", sourceName: "Press release", lastVerifiedAt: nowS,
  previousDateStart: null, dateChangedAt: null, registryDateType: null, ...over,
});

const feed = (items: Catalyst[], over: Partial<CatalystFeed> = {}): CatalystFeed => ({ today: TODAY, lookAheadDays: 90, lastSuccessAt: nowS, lastAttemptAt: nowS, lastRefreshFailed: false, items, ...over });

const fakeApi = (over: Partial<Api>): Api => ({ loginUrl: () => "", ...over }) as Api;
const ids = () => [...document.querySelectorAll(".bt-cat-item")].map((li) => li.getAttribute("data-id"));
const entry = (id: string) => document.querySelector(`.bt-cat-item[data-id="${id}"]`)!;

const SAMPLE = [
  item({ id: "overdue", dateStart: "2026-10-05", program: "Late one" }),
  item({ id: "soon", dateStart: "2026-10-14", eventType: "adcom", status: "unverified", ticker: "SRPT", program: "Elevidys" }),
  item({
    id: "reg", ticker: "INSM", eventType: "readout", status: "estimated", origin: "registry", nctId: "NCT05649748", phase: "Phase II/Phase III", program: "TPIP",
    dateStart: "2026-12-01", dateEnd: "2026-12-31", sourceName: "ClinicalTrials.gov", sourceUrl: "https://clinicaltrials.gov/study/NCT05649748",
    registryDateType: "ANTICIPATED", previousDateStart: "2026-11-01", dateChangedAt: nowS,
  }),
  item({ id: "pdufa", dateStart: "2026-12-15" }),
];

describe("catalyst calendar", () => {
  it("lists events in order with type, status, countdown, source and last-verified date", async () => {
    render(<CatalystModule api={fakeApi({ catalysts: async () => feed(SAMPLE) })} />);
    await screen.findByText("Elevidys");
    expect(ids()).toEqual(["overdue", "soon", "reg", "pdufa"]);

    const pdufa = entry("pdufa").textContent!;
    expect(pdufa).toContain("Dec 15, 2026");
    expect(pdufa).toContain("In 66 days");
    expect(pdufa).toContain("PDUFA date");
    expect(pdufa).toContain("Confirmed");
    expect(pdufa).toContain("Madrigal");
    expect(pdufa).toContain("MASH");
    expect(pdufa).toMatch(/Source: Press release/);
    expect(pdufa).toMatch(/Last verified/);
    expect(screen.getByText(/Registry last synced:/)).toBeTruthy();
  });

  it("labels overdue events, highlights the next seven days and flags changed dates", async () => {
    render(<CatalystModule api={fakeApi({ catalysts: async () => feed(SAMPLE) })} />);
    await screen.findByText("Elevidys");
    expect(entry("overdue").textContent).toMatch(/Overdue by 5 days/);
    expect(entry("overdue").className).toContain("bt-cat-item--overdue");
    expect(entry("soon").textContent).toContain("Within 7 days");
    expect(entry("soon").className).toContain("bt-cat-item--imminent");
    expect(entry("soon").textContent).toContain("Unverified");
    expect(entry("pdufa").textContent).not.toMatch(/Within 7 days|Overdue|Date changed/);
    expect(entry("reg").textContent).toContain("Date changed (was Nov 1, 2026)");
  });

  it("labels registry entries Estimated and explains what the date means", async () => {
    render(<CatalystModule api={fakeApi({ catalysts: async () => feed(SAMPLE) })} />);
    await screen.findByText("TPIP");
    const reg = entry("reg").textContent!;
    expect(reg).toContain("Estimated");
    expect(reg).not.toContain("Confirmed");
    expect(reg).toContain("Dec 1, 2026 – Dec 31, 2026");
    expect(reg).toContain("Registry date type: Anticipated");
    expect(reg).toContain("not when results will be announced");
    expect(entry("reg").querySelector("a")!.getAttribute("href")).toBe("https://clinicaltrials.gov/study/NCT05649748");
    expect(entry("pdufa").textContent).not.toContain("Registry date type");
  });

  it("says when a registry date is Actual", async () => {
    render(<CatalystModule api={fakeApi({ catalysts: async () => feed([item({ id: "a", origin: "registry", status: "estimated", registryDateType: "ACTUAL", dateStart: "2026-10-02" })]) })} />);
    await screen.findByText(/Registry date type: Actual \(already passed\)/);
  });

  it("filters by event type and resets with All", async () => {
    render(<CatalystModule api={fakeApi({ catalysts: async () => feed(SAMPLE) })} />);
    await screen.findByText("Elevidys");
    fireEvent.click(screen.getByRole("button", { name: "Readouts" }));
    expect(ids()).toEqual(["reg"]);
    fireEvent.click(screen.getByRole("button", { name: "AdCom" }));
    expect(ids()).toEqual(["soon"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(ids()).toHaveLength(4);
  });

  it("pages long lists with Show more", async () => {
    const many = Array.from({ length: 60 }, (_, i) => item({ id: `e${i}`, program: `P${i}` }));
    render(<CatalystModule api={fakeApi({ catalysts: async () => feed(many) })} />);
    await screen.findByText("P0");
    expect(ids()).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: /Show more \(35 remaining\)/ }));
    expect(ids()).toHaveLength(50);
  });

  it("shows empty, stale and error states", async () => {
    render(<CatalystModule api={fakeApi({ catalysts: async () => feed([], { lastRefreshFailed: true }) })} />);
    await screen.findByText("No catalysts in the next 90 days.");
    expect(screen.getByText("Stale")).toBeTruthy();
    cleanup();

    const catalysts = vi.fn().mockRejectedValueOnce(new ApiError(500)).mockResolvedValueOnce(feed(SAMPLE));
    render(<CatalystModule api={fakeApi({ catalysts })} />);
    await screen.findByText("The catalyst calendar is unavailable right now.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Elevidys");
  });

  it("keeps working when the market module's API fails, and the reverse", async () => {
    const api = fakeApi({ market: vi.fn().mockRejectedValue(new ApiError(502)), catalysts: async () => feed(SAMPLE) });
    render(
      <div>
        <ModuleBoundary name="Stock Performance"><StockModule api={api} /></ModuleBoundary>
        <ModuleBoundary name="Catalyst Calendar"><CatalystModule api={api} /></ModuleBoundary>
      </div>,
    );
    await screen.findByText("Market data is unavailable right now.");
    await screen.findByText("Elevidys");
  });
});

describe("catalyst admin form", () => {
  const stored: AdminCatalyst = { ...item({ id: "m1" }), notes: "internal", createdAt: nowS, updatedAt: nowS };

  const fill = (label: RegExp, value: string) => {
    const el = screen.getByLabelText(label) as HTMLInputElement;
    el.value = value;
    fireEvent.input(el);
    fireEvent.change(el);
  };

  it("validates required fields and date rules before sending", async () => {
    const createCatalyst = vi.fn();
    render(<CatalystAdmin api={fakeApi({ adminCatalysts: async () => ({ items: [] }), createCatalyst })} />);
    await screen.findByText("No manual entries yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add catalyst" }));
    expect(screen.getAllByText("Required")).toHaveLength(5);
    expect(createCatalyst).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Company/) as HTMLElement).getAttribute("aria-invalid")).toBe("true");

    expect(validateForm({ ticker: "LLY", program: "x", indication: "", eventType: "pdufa", dateStart: "2026-11-10", dateEnd: "2026-11-01", status: "confirmed", nctId: "NCT1", sourceUrl: "", sourceName: "", notes: "" })).toEqual({
      dateEnd: "End date cannot be before the start date",
      nctId: "Format: NCT followed by 8 digits",
    });
  });

  it("adds an entry and reloads the list", async () => {
    const createCatalyst = vi.fn().mockResolvedValue(stored);
    const adminCatalysts = vi.fn().mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: [stored] });
    render(<CatalystAdmin api={fakeApi({ adminCatalysts, createCatalyst })} />);
    await screen.findByText("No manual entries yet.");
    fill(/Company/, "MDGL");
    fill(/Event type/, "pdufa");
    fill(/Drug or programme/, "Rezdiffra");
    fill(/Date \(or range start\)/, "2026-11-20");
    fill(/Verification status/, "confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Add catalyst" }));
    await screen.findByText("Entry added.");
    expect(createCatalyst.mock.calls[0]![0]).toMatchObject({ ticker: "MDGL", eventType: "pdufa", program: "Rezdiffra", dateStart: "2026-11-20", status: "confirmed" });
    expect(await screen.findByRole("button", { name: "Edit MDGL Rezdiffra" })).toBeTruthy();
  });

  it("edits and deletes an existing entry", async () => {
    const updateCatalyst = vi.fn().mockResolvedValue(stored);
    const deleteCatalyst = vi.fn().mockResolvedValue({ ok: true });
    render(<CatalystAdmin api={fakeApi({ adminCatalysts: async () => ({ items: [stored] }), updateCatalyst, deleteCatalyst })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit MDGL Rezdiffra" }));
    expect((screen.getByLabelText(/Drug or programme/) as HTMLInputElement).value).toBe("Rezdiffra");
    expect((screen.getByLabelText(/Notes/) as HTMLTextAreaElement).value).toBe("internal");
    fill(/Drug or programme/, "Resmetirom");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Entry updated.");
    expect(updateCatalyst).toHaveBeenCalledWith("m1", expect.objectContaining({ program: "Resmetirom" }));

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete MDGL Rezdiffra" }));
    expect(deleteCatalyst).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete MDGL Rezdiffra" }));
    await screen.findByText("Entry deleted.");
    expect(deleteCatalyst).toHaveBeenCalledWith("m1");
    confirm.mockRestore();
  });

  it("shows server-side field errors and does not claim the entry was saved", async () => {
    const createCatalyst = vi.fn().mockRejectedValue(new ApiError(400, { sourceUrl: "Use a full http(s) URL" }));
    render(<CatalystAdmin api={fakeApi({ adminCatalysts: async () => ({ items: [] }), createCatalyst })} />);
    await screen.findByText("No manual entries yet.");
    fill(/Company/, "MDGL"); fill(/Event type/, "pdufa"); fill(/Drug or programme/, "X"); fill(/Date \(or range start\)/, "2026-11-20"); fill(/Verification status/, "confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Add catalyst" }));
    await screen.findByText("Use a full http(s) URL");
    expect(screen.getByText("Please correct the highlighted fields.")).toBeTruthy();
    expect(screen.queryByText("Entry added.")).toBeNull();

    createCatalyst.mockRejectedValueOnce(new ApiError(null));
    fireEvent.click(screen.getByRole("button", { name: "Add catalyst" }));
    await waitFor(() => expect(screen.getByText("Save failed. Nothing was saved.")).toBeTruthy());
  });
});
