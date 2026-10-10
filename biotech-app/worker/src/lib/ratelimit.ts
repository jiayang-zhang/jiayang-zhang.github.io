import type { Env } from "../env";

const WINDOW_MS = 60_000;
const FALLBACK_LIMIT = 30;
const buckets = new Map<string, { windowStart: number; count: number }>();

/**
 * Uses the Workers Rate Limiting binding when configured. The in-memory
 * fallback is per isolate, so it only bounds bursts; configure the binding
 * in production (see wrangler.toml).
 */
export async function allowRequest(env: Env, key: string, now = Date.now()): Promise<boolean> {
  if (env.WRITE_LIMITER) return (await env.WRITE_LIMITER.limit({ key })).success;
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= FALLBACK_LIMIT;
}

export function resetRateLimits(): void {
  buckets.clear();
}
