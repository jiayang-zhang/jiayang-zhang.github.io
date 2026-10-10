import { z } from "zod";
import { dashboardConfig } from "../../../shared/config";
import { dedupe, fetchJson, UpstreamError } from "../lib/http";
import type { MarketDataProvider, ProviderProfile, ProviderQuote } from "./types";

// Finnhub conventions (https://finnhub.io/docs/api):
// - /quote: c = current price, pc = previous close, t = last trade (Unix seconds).
//   Unknown symbols come back as all zeros rather than an error.
// - /stock/profile2: marketCapitalization is in millions of `currency`.
//   ETFs and unknown symbols return an empty object.
// - Quote prices are raw exchange prices; pc is the exchange's prior close, so
//   the daily change is unaffected by split adjustment except on a split day.
const quoteSchema = z.object({
  c: z.number().nullable().optional(),
  pc: z.number().nullable().optional(),
  t: z.number().nullable().optional(),
});

const profileSchema = z.object({
  marketCapitalization: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
});

const positive = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export interface FinnhubDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createFinnhubProvider(apiKey: string | undefined, deps: FinnhubDeps = {}): MarketDataProvider {
  const { baseUrl } = dashboardConfig.providers.finnhub;
  const { timeoutMs, retries, backoffBaseMs } = dashboardConfig.network;

  function get<T>(path: string, ticker: string, schema: z.ZodType<T>): Promise<T> {
    if (!apiKey) return Promise.reject(new UpstreamError("config"));
    const url = `${baseUrl}${path}?symbol=${encodeURIComponent(ticker)}`;
    // The key travels in a header, so it never appears in URLs or URL-based logs.
    return dedupe(`finnhub:${path}:${ticker}`, () =>
      fetchJson(url, { schema, headers: { "X-Finnhub-Token": apiKey }, timeoutMs, retries, backoffBaseMs, ...deps }),
    );
  }

  return {
    source: "live",
    async getQuote(ticker): Promise<ProviderQuote | null> {
      const q = await get("/quote", ticker, quoteSchema);
      const price = positive(q.c);
      if (price === null) return null;
      return { price, prevClose: positive(q.pc), quoteTime: positive(q.t) };
    },
    async getProfile(ticker): Promise<ProviderProfile | null> {
      const p = await get("/stock/profile2", ticker, profileSchema);
      const millions = positive(p.marketCapitalization);
      if (millions === null) return null;
      return { marketCap: millions * 1e6, currency: p.currency ?? null };
    },
  };
}
