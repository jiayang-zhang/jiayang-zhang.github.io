import type { DataSource } from "../../../shared/types";

export interface ProviderQuote {
  /** Latest available price. */
  price: number;
  /** Previous official close. */
  prevClose: number | null;
  /** Unix seconds of the provider's last trade. */
  quoteTime: number | null;
}

export interface ProviderProfile {
  /** Market capitalisation in whole units of `currency`. */
  marketCap: number | null;
  currency: string | null;
}

export interface MarketDataProvider {
  readonly source: DataSource;
  /** Resolves null when the provider has no data for the symbol. */
  getQuote(ticker: string): Promise<ProviderQuote | null>;
  getProfile(ticker: string): Promise<ProviderProfile | null>;
}
