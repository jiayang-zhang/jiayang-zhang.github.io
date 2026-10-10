// Central, non-secret configuration for the biotech dashboard.
// Never put API keys, tokens or admin credentials in this file: it is bundled
// into the public frontend. Secrets live in Worker secrets (see .dev.vars.example).

import type { Category, WatchlistCompany } from "./types";

// CIKs and filer types verified against EDGAR (company_tickers.json and the
// submissions API) on 2026-10-10.
// registrySponsors: lead-sponsor names as they appear on ClinicalTrials.gov,
// checked the same day. The first is the search term; a study is kept only if
// its lead sponsor contains one of them (so "Merck KGaA" never matches MRK).
const pharma: WatchlistCompany[] = [
  { ticker: "LLY", name: "Eli Lilly", cik: 59478, filerType: "8-K", aliases: ["Eli Lilly and Company", "Lilly", "Loxo Oncology"], registrySponsors: ["Eli Lilly"] },
  { ticker: "NVO", name: "Novo Nordisk", cik: 353278, filerType: "6-K", aliases: ["Novo Nordisk A/S"], registrySponsors: ["Novo Nordisk"] },
  { ticker: "MRK", name: "Merck & Co.", cik: 310158, filerType: "8-K", aliases: ["Merck", "MSD", "Merck Sharp & Dohme", "Prometheus Biosciences"], registrySponsors: ["Merck Sharp & Dohme"] },
  { ticker: "PFE", name: "Pfizer", cik: 78003, filerType: "8-K", aliases: ["Pfizer Inc.", "Seagen"], registrySponsors: ["Pfizer"] },
  { ticker: "AZN", name: "AstraZeneca", cik: 901832, filerType: "6-K", aliases: ["AstraZeneca PLC", "Alexion"], registrySponsors: ["AstraZeneca"] },
  { ticker: "ABBV", name: "AbbVie", cik: 1551152, filerType: "8-K", aliases: ["AbbVie Inc.", "Allergan", "Cerevel Therapeutics"], registrySponsors: ["AbbVie"] },
  { ticker: "BMY", name: "Bristol Myers Squibb", cik: 14272, filerType: "8-K", aliases: ["Bristol-Myers Squibb", "BMS", "Celgene", "Karuna Therapeutics"], registrySponsors: ["Bristol-Myers Squibb", "Bristol Myers Squibb"] },
  { ticker: "GSK", name: "GSK", cik: 1131399, filerType: "6-K", aliases: ["GSK plc", "GlaxoSmithKline", "ViiV Healthcare"], registrySponsors: ["GlaxoSmithKline", "GSK"] },
];

const biotech: WatchlistCompany[] = [
  { ticker: "ALNY", name: "Alnylam", cik: 1178670, filerType: "8-K", aliases: ["Alnylam Pharmaceuticals"], registrySponsors: ["Alnylam"] },
  { ticker: "ARGX", name: "argenx", cik: 1697862, filerType: "6-K", aliases: ["argenx SE", "argenx N.V."], registrySponsors: ["argenx"] },
  { ticker: "INSM", name: "Insmed", cik: 1104506, filerType: "8-K", aliases: ["Insmed Incorporated"], registrySponsors: ["Insmed"] },
  { ticker: "BBIO", name: "BridgeBio", cik: 1743881, filerType: "8-K", aliases: ["BridgeBio Pharma", "Eidos Therapeutics", "QED Therapeutics"], registrySponsors: ["BridgeBio"] },
  { ticker: "IONS", name: "Ionis", cik: 874015, filerType: "8-K", aliases: ["Ionis Pharmaceuticals", "Isis Pharmaceuticals", "Akcea Therapeutics"], registrySponsors: ["Ionis"] },
  { ticker: "SRPT", name: "Sarepta", cik: 873303, filerType: "8-K", aliases: ["Sarepta Therapeutics", "AVI BioPharma"], registrySponsors: ["Sarepta"] },
  { ticker: "MDGL", name: "Madrigal", cik: 1157601, filerType: "8-K", aliases: ["Madrigal Pharmaceuticals"], registrySponsors: ["Madrigal"] },
  { ticker: "VKTX", name: "Viking Therapeutics", cik: 1607678, filerType: "8-K", aliases: ["Viking"], registrySponsors: ["Viking Therapeutics"] },
  { ticker: "CRSP", name: "CRISPR Therapeutics", cik: 1674416, filerType: "8-K", aliases: ["CRISPR Therapeutics AG"], registrySponsors: ["CRISPR Therapeutics"] },
  { ticker: "NTLA", name: "Intellia", cik: 1652130, filerType: "8-K", aliases: ["Intellia Therapeutics"], registrySponsors: ["Intellia"] },
];

export const dashboardConfig = {
  watchlist: { pharma, biotech },

  // Benchmarks are ETFs, kept apart from the watchlist so they are never
  // filtered, counted or matched as companies.
  benchmarks: {
    pharma: { ticker: "PPH", name: "VanEck Pharmaceutical ETF" },
    biotech: { ticker: "XBI", name: "SPDR S&P Biotech ETF" },
  } satisfies Record<Category, { ticker: string; name: string }>,

  categoryLabels: { pharma: "Pharmaceutical", biotech: "Biotech" } satisfies Record<Category, string>,

  providers: {
    marketData: "finnhub" as "finnhub",
    finnhub: { baseUrl: "https://finnhub.io/api/v1" },
    edgar: { baseUrl: "https://data.sec.gov" },
    clinicalTrials: { baseUrl: "https://clinicaltrials.gov/api/v2" },
  },

  refreshIntervals: {
    pricesMs: 300_000,
    newsMs: 900_000,
    catalystsMs: 3_600_000,
  },

  market: {
    timeZone: "America/New_York",
    // Regular session, minutes after local midnight.
    sessionOpenMinutes: 9 * 60 + 30,
    sessionCloseMinutes: 16 * 60,
    sparklineDays: 5,
    // A quote older than this many refresh intervals during market hours is stale.
    staleAfterIntervals: 3,
  },

  network: {
    timeoutMs: 8_000,
    retries: 2,
    backoffBaseMs: 400,
    providerConcurrency: 4,
  },

  news: {
    initialPageSize: 20,
    backfillMonths: 12,
    showUnreviewedEvents: true,
  },

  clinical: {
    classificationMode: "llm-with-review" as "llm-with-review" | "manual-only",
    includePhase1_2Trials: false,
    llmModel: "claude-opus-5-5",
  },

  catalysts: {
    lookAheadDays: 90,
    includeRegistryEstimatedReadouts: true,
    // Past events stay visible, labelled overdue, for this long.
    overdueGraceDays: 30,
    highlightWithinDays: 7,
    // How long a moved date keeps its "date changed" label.
    dateChangedLabelDays: 30,
    pageSize: 25,
  },

  display: {
    currency: "USD",
    locale: "en-US",
    priceDecimals: 2,
    percentDecimals: 2,
    // "green-up": gains green, losses red. "red-up": the East Asian convention.
    changeColorConvention: "green-up" as "green-up" | "red-up",
  },
};

export type DashboardConfig = typeof dashboardConfig;

export function allCompanies(): Array<WatchlistCompany & { category: Category }> {
  return [
    ...dashboardConfig.watchlist.pharma.map((c) => ({ ...c, category: "pharma" as const })),
    ...dashboardConfig.watchlist.biotech.map((c) => ({ ...c, category: "biotech" as const })),
  ];
}

export function benchmarkTickers(): string[] {
  return Object.values(dashboardConfig.benchmarks).map((b) => b.ticker);
}

export function allTickers(): string[] {
  return [...benchmarkTickers(), ...allCompanies().map((c) => c.ticker)];
}
