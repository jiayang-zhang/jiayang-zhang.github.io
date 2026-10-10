// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot, StockRow } from "../../shared/types";
import { ApiError, type Api } from "../../web/src/api";
import { AdminApp } from "../../web/src/components/AdminApp";
import { ModuleBoundary } from "../../web/src/components/ModuleCard";
import { StockModule } from "../../web/src/components/StockModule";

afterEach(cleanup);

const row = (over: Partial<StockRow>): StockRow => ({
  ticker: "X", name: "X Corp", category: "pharma", isBenchmark: false, benchmarkTicker: "PPH", price: 10, prevClose: 10,
  changePct: 0, relativePp: 0, sparkline: null, marketCap: 1e9, quoteTime: 1, fetchedAt: 1, stale: false, ...over,
});

const snapshot = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  source: "live", generatedAt: 1_760_000_000, marketOpen: false, lastSuccessAt: 1_760_000_000, lastAttemptAt: 1_760_000_000, lastRefreshFailed: false,
  benchmarks: [
    row({ ticker: "PPH", name: "Pharma ETF", isBenchmark: true, changePct: 1, relativePp: null, marketCap: null }),
    row({ ticker: "XBI", name: "Biotech ETF", category: "biotech", benchmarkTicker: "XBI", isBenchmark: true, changePct: -2, relativePp: null, marketCap: null }),
  ],
  companies: [
    row({ ticker: "LLY", name: "Eli Lilly", price: 800, changePct: 3, relativePp: 2, marketCap: 7e11, sparkline: [1, 2, 3, 4, 5] }),
    row({ ticker: "MRK", name: "Merck", price: null, prevClose: null, changePct: null, relativePp: null, marketCap: null }),
    row({ ticker: "PFE", name: "Pfizer", price: 25, changePct: -1, relativePp: -2, marketCap: 1.4e11 }),
    row({ ticker: "VKTX", name: "Viking", category: "biotech", benchmarkTicker: "XBI", price: 30, changePct: 5, relativePp: 7, marketCap: 3e9 }),
  ],
  ...over,
});

const api = (market: Api["market"]): Api => ({ market, session: vi.fn(), refreshMarket: vi.fn(), refreshProfiles: vi.fn(), loginUrl: (r) => `https://api.test/admin/login?return=${r}` }) as Api;

const companyTickers = () => {
  const bodies = document.querySelectorAll("tbody");
  return [...bodies[1]!.querySelectorAll("tr")].map((tr) => tr.getAttribute("data-ticker"));
};
const benchmarkTickers = () => [...document.querySelectorAll("tbody")[0]!.querySelectorAll("tr")].map((tr) => tr.getAttribute("data-ticker"));

async function renderReady(s = snapshot()) {
  render(<StockModule api={api(async () => s)} />);
  await screen.findByRole("table");
}

describe("stock table", () => {
  it("pins benchmarks above companies and shows N/A for missing values", async () => {
    await renderReady();
    expect(benchmarkTickers()).toEqual(["PPH", "XBI"]);
    expect(companyTickers()).toEqual(["LLY", "MRK", "PFE", "VKTX"]);
    const mrk = document.querySelector('tr[data-ticker="MRK"]')!;
    const cells = [...mrk.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells.slice(2)).toEqual(["N/A", "N/A", "N/A", "N/A", "N/A"]);
    expect(mrk.textContent).not.toMatch(/0\.00/);
    expect(document.querySelector('tr[data-ticker="LLY"]')!.textContent).toContain("+2.00 pp");
  });

  it("sorts on header click, toggles direction, exposes aria-sort and keeps N/A last", async () => {
    await renderReady();
    const button = screen.getByRole("button", { name: /Daily change: latest price/ });
    const header = button.closest("th")!;

    fireEvent.click(button);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(companyTickers()).toEqual(["VKTX", "LLY", "PFE", "MRK"]);

    fireEvent.click(button);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(companyTickers()).toEqual(["PFE", "LLY", "VKTX", "MRK"]);

    expect(benchmarkTickers()).toEqual(["PPH", "XBI"]);
    expect(screen.getByRole("button", { name: /Ticker symbol/ }).closest("th")!.getAttribute("aria-sort")).toBe("none");
  });

  it("filters by category without removing benchmark rows, and resets with All", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Biotech" }));
    expect(companyTickers()).toEqual(["VKTX"]);
    expect(benchmarkTickers()).toEqual(["PPH", "XBI"]);
    expect(screen.getByRole("button", { name: "Biotech" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Pharmaceutical" }));
    expect(companyTickers()).toEqual(["LLY", "MRK", "PFE"]);

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(companyTickers()).toHaveLength(4);
  });

  it("labels the sparkline for assistive technology", async () => {
    await renderReady();
    expect(screen.getByRole("img", { name: /LLY last 5 trading days: 1\.00 to 5\.00/ })).toBeTruthy();
  });

  it("says the price is the latest available when the market is closed", async () => {
    await renderReady();
    expect(screen.getByText(/Market closed\. Showing the latest available price, not a new trade\./)).toBeTruthy();
    expect(screen.getByText(/Last successful update:/)).toBeTruthy();
  });
});

describe("module states", () => {
  it("shows loading, then an error state with retry when the API fails", async () => {
    const market = vi.fn().mockRejectedValueOnce(new ApiError(503)).mockResolvedValueOnce(snapshot());
    render(<StockModule api={api(market)} />);
    expect(screen.getByText("Loading market data…")).toBeTruthy();
    await screen.findByText("Market data is unavailable right now.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("table");
  });

  it("shows an empty state when no prices exist", async () => {
    const empty = snapshot({ lastSuccessAt: null });
    for (const r of [...empty.benchmarks, ...empty.companies]) r.price = null;
    render(<StockModule api={api(async () => empty)} />);
    await screen.findByText("No market data has been collected yet.");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("flags stale data", async () => {
    await renderReady(snapshot({ lastRefreshFailed: true, companies: [row({ ticker: "LLY", stale: true })] }));
    expect(screen.getAllByText("Stale").length).toBe(2);
  });

  it("shows a MOCK DATA banner for mock data and none for live data", async () => {
    await renderReady(snapshot({ source: "mock" }));
    expect(screen.getByText("MOCK DATA")).toBeTruthy();
    cleanup();
    await renderReady(snapshot());
    expect(screen.queryByText("MOCK DATA")).toBeNull();
  });

  it("contains a crashing module so its neighbours still render", async () => {
    const Boom = () => {
      throw new Error("boom");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <ModuleBoundary name="News">
          <Boom />
        </ModuleBoundary>
        <ModuleBoundary name="Stock Performance">
          <StockModule api={api(async () => snapshot())} />
        </ModuleBoundary>
      </div>,
    );
    await screen.findByRole("table");
    expect(screen.getByRole("alert").textContent).toContain("News could not be displayed");
    quiet.mockRestore();
  });

  it("collapses and expands the module", async () => {
    await renderReady();
    const toggle = screen.getByRole("button", { name: /Stock Performance/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("bt-stocks-body")!.hidden).toBe(true);
  });
});

describe("admin page", () => {
  it("shows a sign-in link and no controls to signed-out visitors", async () => {
    const a = api(async () => snapshot());
    a.session = vi.fn().mockRejectedValue(new ApiError(401));
    render(<AdminApp api={a} />);
    await screen.findByText("Administrator sign-in required.");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toContain("/admin/login?return=");
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
  });

  it("lets the signed-in administrator trigger a refresh and reports partial failure", async () => {
    const a = api(async () => snapshot());
    a.session = vi.fn().mockResolvedValue({ email: "owner@example.com" });
    a.refreshMarket = vi.fn().mockResolvedValue({ ran: true, updated: 18, failed: ["LLY", "XBI"] });
    render(<AdminApp api={a} />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh prices now" }));
    await waitFor(() => expect(screen.getByText("Updated 18; failed: LLY, XBI.")).toBeTruthy());
    expect(screen.getByText("Signed in as owner@example.com")).toBeTruthy();
  });
});
