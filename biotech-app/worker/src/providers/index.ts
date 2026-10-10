import { dashboardConfig } from "../../../shared/config";
import type { Env } from "../env";
import { createFinnhubProvider } from "./finnhub";
import { createMockProvider } from "./mock";
import type { MarketDataProvider } from "./types";

export function createMarketDataProvider(env: Env): MarketDataProvider {
  if (env.DATA_MODE === "mock") return createMockProvider();
  switch (dashboardConfig.providers.marketData) {
    case "finnhub":
      return createFinnhubProvider(env.FINNHUB_API_KEY);
  }
}
