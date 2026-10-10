import type { AdminSession, MarketSnapshot } from "../../shared/types";

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "network error" : `request failed (${status})`);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new ApiError(res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(null);
  } finally {
    clearTimeout(timer);
  }
}

export interface RefreshResult {
  ran: boolean;
  updated: number;
  failed: string[];
}

export function createApi(base: string) {
  const root = base.replace(/\/+$/, "");
  const admin = (path: string, method = "GET") =>
    request(`${root}${path}`, {
      method,
      credentials: "include",
      headers: method === "GET" ? undefined : { "X-Biotech-Admin": "1" },
    });
  return {
    market: () => request<MarketSnapshot>(`${root}/v1/market`),
    session: () => admin("/admin/session") as Promise<AdminSession>,
    refreshMarket: () => admin("/admin/refresh/market", "POST") as Promise<RefreshResult>,
    refreshProfiles: () => admin("/admin/refresh/profiles", "POST") as Promise<RefreshResult>,
    loginUrl: (returnTo: string) => `${root}/admin/login?return=${encodeURIComponent(returnTo)}`,
  };
}

export type Api = ReturnType<typeof createApi>;
