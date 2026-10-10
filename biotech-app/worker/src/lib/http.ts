import type { ZodType } from "zod";

export type UpstreamKind = "timeout" | "rate_limited" | "http" | "invalid" | "network" | "config";

/**
 * Error for anything that goes wrong talking to an external provider. The
 * message is built only from the kind and status, so it is safe to log:
 * it never contains URLs, headers or response bodies.
 */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamKind,
    readonly status?: number,
  ) {
    super(status ? `upstream ${kind} (${status})` : `upstream ${kind}`);
    this.name = "UpstreamError";
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  retries: number;
  backoffBaseMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchJsonOptions<T> extends RequestOptions {
  schema: ZodType<T>;
}

const MAX_RETRY_AFTER_MS = 5_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryable(err: UpstreamError): boolean {
  if (err.kind === "timeout" || err.kind === "network" || err.kind === "rate_limited") return true;
  return err.kind === "http" && (err.status ?? 0) >= 500;
}

type Attempt<T> = { value: T } | { error: UpstreamError; retryAfterMs?: number };

async function attempt<T>(url: string, o: RequestOptions, read: (res: Response) => Promise<T>): Promise<Attempt<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs);
  try {
    const res = await (o.fetchImpl ?? fetch)(url, { headers: o.headers, signal: controller.signal });
    if (res.status === 429) {
      const header = Number(res.headers.get("Retry-After"));
      const retryAfterMs = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, MAX_RETRY_AFTER_MS) : undefined;
      return { error: new UpstreamError("rate_limited", 429), retryAfterMs };
    }
    if (!res.ok) return { error: new UpstreamError("http", res.status) };
    return { value: await read(res) };
  } catch (err) {
    if (err instanceof UpstreamError) return { error: err };
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return { error: new UpstreamError(aborted ? "timeout" : "network") };
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(url: string, o: RequestOptions, read: (res: Response) => Promise<T>): Promise<T> {
  const sleep = o.sleep ?? defaultSleep;
  for (let i = 0; ; i++) {
    const result = await attempt(url, o, read);
    if ("value" in result) return result.value;
    if (i >= o.retries || !retryable(result.error)) throw result.error;
    await sleep(result.retryAfterMs ?? o.backoffBaseMs * 2 ** i);
  }
}

/** GET JSON with a timeout, schema validation and exponential backoff on transient failures. */
export function fetchJson<T>(url: string, o: FetchJsonOptions<T>): Promise<T> {
  return withRetry(url, o, async (res) => {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new UpstreamError("invalid");
    }
    const parsed = o.schema.safeParse(body);
    if (!parsed.success) throw new UpstreamError("invalid");
    return parsed.data;
  });
}

/** GET a text document with the same timeout and retry behaviour. */
export function fetchText(url: string, o: RequestOptions): Promise<string> {
  return withRetry(url, o, (res) => res.text());
}

const inflight = new Map<string, Promise<unknown>>();

/** Collapses concurrent calls with the same key into one underlying call. */
export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Runs tasks with a bounded number in flight; never rejects, returns settled results in order. */
export async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<PromiseSettledResult<O>[]> {
  const results: PromiseSettledResult<O>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
