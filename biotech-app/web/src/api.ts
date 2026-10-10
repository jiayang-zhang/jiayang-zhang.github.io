import type { ClinicalFeed, EventCategory, ReviewInput, ReviewItem, ReviewStatus } from "../../shared/events";
import type { AdminCatalyst, AdminSession, CatalystFeed, CatalystInput, MarketSnapshot } from "../../shared/types";

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  constructor(
    readonly status: number | null,
    /** Per-field validation messages, when the server rejected a form. */
    readonly fields: Record<string, string> | null = null,
  ) {
    super(status === null ? "network error" : `request failed (${status})`);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { fields?: Record<string, string> } | null;
      throw new ApiError(res.status, body?.fields ?? null);
    }
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
  backlog?: number;
}

export interface ClinicalStatus {
  mode: string;
  model: string;
  promptVersion: string;
  classifierConfigured: boolean;
  documents: Record<string, number>;
  events: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
}

export function createApi(base: string) {
  const root = base.replace(/\/+$/, "");
  const admin = <T>(path: string, method = "GET", body?: unknown) =>
    request<T>(`${root}${path}`, {
      method,
      credentials: "include",
      headers: method === "GET" ? undefined : { "X-Biotech-Admin": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    market: () => request<MarketSnapshot>(`${root}/v1/market`),
    catalysts: () => request<CatalystFeed>(`${root}/v1/catalysts`),
    events: (category: EventCategory | null, offset: number) => request<ClinicalFeed>(`${root}/v1/events?offset=${offset}${category ? `&category=${category}` : ""}`),
    session: () => admin<AdminSession>("/admin/session"),
    reviewQueue: (status: ReviewStatus) => admin<{ items: ReviewItem[] }>(`/admin/review?status=${status}`),
    saveReview: (id: string, input: ReviewInput) => admin<ReviewItem>(`/admin/review/${encodeURIComponent(id)}`, "PUT", input),
    confirmReview: (id: string, input: ReviewInput) => admin<ReviewItem>(`/admin/review/${encodeURIComponent(id)}/confirm`, "POST", input),
    rejectReview: (id: string) => admin<ReviewItem>(`/admin/review/${encodeURIComponent(id)}/reject`, "POST"),
    clinicalStatus: () => admin<ClinicalStatus>("/admin/clinical/status"),
    refreshClinical: (step: "discover" | "process") => admin<RefreshResult>("/admin/refresh/clinical", "POST", { step }),
    refreshSignals: () => admin<RefreshResult>("/admin/refresh/signals", "POST"),
    refreshMarket: () => admin<RefreshResult>("/admin/refresh/market", "POST"),
    refreshProfiles: () => admin<RefreshResult>("/admin/refresh/profiles", "POST"),
    refreshCatalysts: () => admin<RefreshResult>("/admin/refresh/catalysts", "POST"),
    adminCatalysts: () => admin<{ items: AdminCatalyst[] }>("/admin/catalysts"),
    createCatalyst: (input: CatalystInput) => admin<AdminCatalyst>("/admin/catalysts", "POST", input),
    updateCatalyst: (id: string, input: CatalystInput) => admin<AdminCatalyst>(`/admin/catalysts/${encodeURIComponent(id)}`, "PUT", input),
    deleteCatalyst: (id: string) => admin<{ ok: true }>(`/admin/catalysts/${encodeURIComponent(id)}`, "DELETE"),
    loginUrl: (returnTo: string) => `${root}/admin/login?return=${encodeURIComponent(returnTo)}`,
  };
}

export type Api = ReturnType<typeof createApi>;
