import type { MarketDataProvider } from "./types";

// Deterministic fake data for local development. Rows written by this
// provider are stored with source "mock" and the UI shows a MOCK DATA banner.
function seed(ticker: string): number {
  let h = 0;
  for (const ch of ticker) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return h;
}

export function createMockProvider(now: () => number = Date.now): MarketDataProvider {
  return {
    source: "mock",
    async getQuote(ticker) {
      const s = seed(ticker);
      const prevClose = 20 + (s % 400);
      const price = prevClose * (1 + ((s % 81) - 40) / 1000);
      return { price: Number(price.toFixed(2)), prevClose, quoteTime: Math.floor(now() / 1000) };
    },
    async getProfile(ticker) {
      return { marketCap: (1 + (seed(ticker) % 500)) * 1e9, currency: "USD" };
    },
  };
}
