import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../worker/src/app";
import type { Env } from "../../worker/src/env";
import { UpstreamError } from "../../worker/src/lib/http";
import { resetRateLimits } from "../../worker/src/lib/ratelimit";
import type { MarketDataProvider } from "../../worker/src/providers/types";
import { clearSnapshotCache } from "../../worker/src/services/market";
import { createTestDb } from "./d1";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const ADMIN = "owner@example.com";
const ORIGIN = "https://jiayangzh.com";
const API = "https://api.jiayangzh.com";

let sign: (claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expired?: boolean }) => Promise<string>;
let foreignToken: string;
let getKey: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  sign = (claims, o = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.issuer ?? TEAM)
      .setAudience(o.audience ?? AUD)
      .setIssuedAt()
      .setExpirationTime(o.expired ? "-1h" : "1h")
      .sign(privateKey);
  const other = await generateKeyPair("RS256");
  foreignToken = await new SignJWT({ email: ADMIN }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TEAM).setAudience(AUD).setExpirationTime("1h").sign(other.privateKey);
});

const quoteProvider: MarketDataProvider = {
  source: "live",
  getQuote: async () => ({ price: 10, prevClose: 10, quoteTime: Math.floor(Date.now() / 1000) }),
  getProfile: async () => ({ marketCap: 1e9, currency: "USD" }),
};

let env: Env;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  clearSnapshotCache();
  env = { DB: createTestDb(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: ADMIN, ALLOWED_ORIGINS: ORIGIN };
  app = createApp({ auth: { getKey }, provider: () => quoteProvider });
});

const call = (path: string, init: RequestInit = {}, e: Env = env) => app.request(`${API}${path}`, init, e);
const adminHeaders = (token: string, extra: Record<string, string> = {}) => ({ "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN, "X-Biotech-Admin": "1", ...extra });

describe("authorisation", () => {
  it("rejects unauthenticated requests on every admin route and method", async () => {
    const routes = app.routes.filter((r) => r.path.startsWith("/admin") && r.method !== "ALL" && !r.path.includes("*"));
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const r of routes) {
      const res = await call(r.path, { method: r.method, headers: { Origin: ORIGIN, "X-Biotech-Admin": "1" } });
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect((await call("/admin/anything/else", { method })).status, method).toBe(401);
    }
  });

  it("rejects invalid, expired, foreign-signed and wrong-audience tokens", async () => {
    const bad = [
      "not-a-jwt",
      foreignToken,
      await sign({ email: ADMIN }, { expired: true }),
      await sign({ email: ADMIN }, { audience: "another-app" }),
      await sign({ email: ADMIN }, { issuer: "https://evil.cloudflareaccess.com" }),
      await sign({}),
    ];
    for (const token of bad) expect((await call("/admin/session", { headers: adminHeaders(token) })).status).toBe(401);
  });

  it("rejects a valid Access user who is not on the admin allow-list", async () => {
    const res = await call("/admin/session", { headers: adminHeaders(await sign({ email: "visitor@example.com" })) });
    expect(res.status).toBe(401);
  });

  it("fails closed when Access is not configured", async () => {
    const token = await sign({ email: ADMIN });
    for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_EMAILS"] as const) {
      expect((await call("/admin/session", { headers: adminHeaders(token) }, { ...env, [missing]: undefined })).status, missing).toBe(401);
    }
  });

  it("accepts the administrator via header or Access cookie", async () => {
    const token = await sign({ email: "Owner@Example.com" });
    const viaHeader = await call("/admin/session", { headers: adminHeaders(token) });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.json()).toEqual({ email: ADMIN });
    expect((await call("/admin/session", { headers: { Cookie: `other=1; CF_Authorization=${token}` } })).status).toBe(200);
  });

  it("allows the development bypass on localhost only", async () => {
    const dev = { ...env, DEV_ADMIN_EMAIL: "dev@example.com" };
    expect((await app.request("http://localhost:8787/admin/session", {}, dev)).status).toBe(200);
    expect((await call("/admin/session", {}, dev)).status).toBe(401);
  });
});

describe("CSRF and rate limiting", () => {
  it("rejects writes without an allowed Origin or without the custom header", async () => {
    const token = await sign({ email: ADMIN });
    const post = (headers: Record<string, string>) => call("/admin/refresh/market", { method: "POST", headers });
    expect((await post({ "Cf-Access-Jwt-Assertion": token, "X-Biotech-Admin": "1" })).status).toBe(403);
    expect((await post({ "Cf-Access-Jwt-Assertion": token, Origin: "https://evil.example", "X-Biotech-Admin": "1" })).status).toBe(403);
    expect((await post({ "Cf-Access-Jwt-Assertion": token, Origin: ORIGIN })).status).toBe(403);
    expect((await post(adminHeaders(token))).status).toBe(200);
  });

  it("lets the administrator trigger a refresh and records it in the audit log", async () => {
    const res = await call("/admin/refresh/market", { method: "POST", headers: adminHeaders(await sign({ email: ADMIN })) });
    expect(await res.json()).toMatchObject({ ran: true, updated: 20, failed: [] });
    const audit = await env.DB.prepare("SELECT actor, action FROM audit_log").first();
    expect(audit).toEqual({ actor: ADMIN, action: "refresh.market" });
  });

  it("rate limits admin endpoints per client", async () => {
    const headers = { "CF-Connecting-IP": "203.0.113.9" };
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call("/admin/session", { headers })).status;
    expect(last).toBe(429);
    expect((await call("/admin/session", { headers: { "CF-Connecting-IP": "203.0.113.10" } })).status).toBe(401);
  });

  it("uses the platform rate limiter when bound", async () => {
    const limited = { ...env, WRITE_LIMITER: { limit: async () => ({ success: false }) } };
    expect((await call("/admin/session", {}, limited)).status).toBe(429);
  });

  it("only redirects after login to an allowed origin", async () => {
    const headers = adminHeaders(await sign({ email: ADMIN }));
    const ok = await call(`/admin/login?return=${encodeURIComponent(`${ORIGIN}/biotech/admin/?x=1`)}`, { headers });
    expect(ok.headers.get("Location")).toBe(`${ORIGIN}/biotech/admin/?x=1`);
    for (const target of ["https://evil.example/", "javascript:alert(1)", "//evil.example", "nonsense"]) {
      const res = await call(`/admin/login?return=${encodeURIComponent(target)}`, { headers });
      expect(res.headers.get("Location"), target).toBe(`${ORIGIN}/biotech/admin/`);
    }
  });
});

describe("public API", () => {
  it("serves the market snapshot without authentication and without admin fields", async () => {
    await call("/admin/refresh/market", { method: "POST", headers: adminHeaders(await sign({ email: ADMIN })) });
    const res = await call("/v1/market");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["benchmarks", "companies", "generatedAt", "lastAttemptAt", "lastRefreshFailed", "lastSuccessAt", "marketOpen", "source"]);
    expect(JSON.stringify(body)).not.toMatch(/owner@example\.com|last_error|audit/);
  });

  it("serves an empty snapshot before any data exists", async () => {
    const body = (await (await call("/v1/market")).json()) as { companies: Array<{ price: number | null }>; lastSuccessAt: number | null };
    expect(body.lastSuccessAt).toBeNull();
    expect(body.companies.every((c) => c.price === null)).toBe(true);
  });

  it("has no public write endpoints", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await call("/v1/market", { method })).status).toBe(404);
  });

  it("sets CORS only for allowed origins", async () => {
    expect((await call("/v1/market", { headers: { Origin: ORIGIN } })).headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect((await call("/v1/market", { headers: { Origin: "https://evil.example" } })).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns a generic error and never leaks provider details", async () => {
    const failing = createApp({ auth: { getKey }, provider: () => { throw new Error("key=SECRETVALUE at https://finnhub.io"); } });
    const res = await failing.request(`${API}/admin/refresh/market`, { method: "POST", headers: adminHeaders(await sign({ email: ADMIN })) }, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
  });

  it("keeps serving stored data when the provider fails", async () => {
    const token = await sign({ email: ADMIN });
    await call("/admin/refresh/market", { method: "POST", headers: adminHeaders(token) });
    clearSnapshotCache();
    const down: MarketDataProvider = { source: "live", getQuote: async () => { throw new UpstreamError("http", 503); }, getProfile: async () => null };
    const broken = createApp({ auth: { getKey }, provider: () => down });
    const refresh = await broken.request(`${API}/admin/refresh/market`, { method: "POST", headers: adminHeaders(token) }, env);
    expect(((await refresh.json()) as { failed: string[] }).failed).toHaveLength(20);
    const body = (await (await broken.request(`${API}/v1/market`, {}, env)).json()) as { lastRefreshFailed: boolean; companies: Array<{ price: number | null }> };
    expect(body.lastRefreshFailed).toBe(true);
    expect(body.companies.every((c) => c.price === 10)).toBe(true);
  });
});
