import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { dedupe, fetchJson, UpstreamError } from "../../worker/src/lib/http";
import { createFinnhubProvider } from "../../worker/src/providers/finnhub";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const base = { schema: z.object({ ok: z.boolean() }), timeoutMs: 50, retries: 2, backoffBaseMs: 10 };

describe("fetchJson", () => {
  it("backs off exponentially on 429 and then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({ ok: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(fetchJson("https://x.test", { ...base, fetchImpl, sleep })).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it("honours Retry-After, capped", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 429, { "Retry-After": "2" })).mockResolvedValueOnce(json({}, 429, { "Retry-After": "600" })).mockResolvedValueOnce(json({ ok: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await fetchJson("https://x.test", { ...base, fetchImpl, sleep });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 5000]);
  });

  it("gives up after the retry budget with a rate_limited error", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({}, 429));
    const err = await fetchJson("https://x.test", { ...base, fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.kind).toBe("rate_limited");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors or invalid payloads", async () => {
    const notFound = vi.fn().mockResolvedValue(json({}, 404));
    await expect(fetchJson("https://x.test", { ...base, fetchImpl: notFound })).rejects.toMatchObject({ kind: "http", status: 404 });
    expect(notFound).toHaveBeenCalledTimes(1);

    const wrongShape = vi.fn().mockResolvedValue(json({ ok: "yes" }));
    await expect(fetchJson("https://x.test", { ...base, fetchImpl: wrongShape })).rejects.toMatchObject({ kind: "invalid" });
    expect(wrongShape).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging request", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    await expect(fetchJson("https://x.test", { ...base, retries: 0, fetchImpl })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("never puts the URL or key in the error message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({}, 500));
    const err = await fetchJson("https://x.test/path?token=SECRETVALUE", { ...base, retries: 0, fetchImpl }).catch((e) => e);
    expect(String(err.message)).not.toMatch(/SECRETVALUE|x\.test/);
  });
});

describe("dedupe", () => {
  it("collapses concurrent calls with the same key", async () => {
    const fn = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(1), 5)));
    const [a, b] = await Promise.all([dedupe("k", fn), dedupe("k", fn)]);
    expect([a, b]).toEqual([1, 1]);
    expect(fn).toHaveBeenCalledTimes(1);
    await dedupe("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("Finnhub provider", () => {
  it("maps a quote and sends the key in a header, not the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ c: 101.5, pc: 100, t: 1_760_000_000, d: 1.5, dp: 1.5 }));
    const q = await createFinnhubProvider("KEY123", { fetchImpl }).getQuote("LLY");
    expect(q).toEqual({ price: 101.5, prevClose: 100, quoteTime: 1_760_000_000 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).not.toContain("KEY123");
    expect(init.headers["X-Finnhub-Token"]).toBe("KEY123");
  });

  it("treats the all-zero response for unknown symbols as no data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ c: 0, pc: 0, t: 0 }));
    expect(await createFinnhubProvider("K", { fetchImpl }).getQuote("NOPE")).toBeNull();
  });

  it("converts market cap from millions and returns null for an empty profile", async () => {
    const full = vi.fn().mockResolvedValue(json({ marketCapitalization: 750_000, currency: "USD" }));
    expect(await createFinnhubProvider("K", { fetchImpl: full }).getProfile("LLY")).toEqual({ marketCap: 7.5e11, currency: "USD" });
    const empty = vi.fn().mockResolvedValue(json({}));
    expect(await createFinnhubProvider("K", { fetchImpl: empty }).getProfile("XBI")).toBeNull();
  });

  it("rejects malformed payloads and fails cleanly without a key", async () => {
    const bad = vi.fn().mockResolvedValue(json({ c: "101" }));
    await expect(createFinnhubProvider("K", { fetchImpl: bad }).getQuote("LLY")).rejects.toMatchObject({ kind: "invalid" });
    await expect(createFinnhubProvider(undefined).getQuote("LLY")).rejects.toMatchObject({ kind: "config" });
  });
});
