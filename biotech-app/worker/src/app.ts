import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AdminSession } from "../../shared/types";
import { authenticate, type AuthDeps } from "./auth";
import { writeAudit } from "./db";
import { listVar, type Env } from "./env";
import { UpstreamError } from "./lib/http";
import { allowRequest } from "./lib/ratelimit";
import { createMarketDataProvider } from "./providers";
import type { MarketDataProvider } from "./providers/types";
import { getSnapshot, refreshPrices, refreshProfiles } from "./services/market";

export interface AppDeps {
  auth?: AuthDeps;
  provider?: (env: Env) => MarketDataProvider;
}

type AppEnv = { Bindings: Env; Variables: { session: AdminSession } };

const ADMIN_HEADER = "X-Biotech-Admin";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>();
  const provider = (env: Env) => (deps.provider ?? createMarketDataProvider)(env);

  app.use(
    "*",
    cors({
      origin: (origin, c) => (listVar((c.env as Env).ALLOWED_ORIGINS).includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", ADMIN_HEADER],
      maxAge: 600,
    }),
  );

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });

  // ---- Public, read-only ----

  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.get("/v1/market", async (c) => {
    const snapshot = await getSnapshot(c.env.DB, c.env.DATA_MODE === "mock" ? "mock" : "live");
    c.header("Cache-Control", "public, max-age=30");
    return c.json(snapshot);
  });

  // ---- Admin: every route below requires a verified administrator session ----

  app.use("/admin/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    if (!(await allowRequest(c.env, `admin:${ip}`))) return c.json({ error: "rate_limited" }, 429);

    const session = await authenticate(c.req.raw, c.env, deps.auth);
    if (!session) return c.json({ error: "unauthorized" }, 401);

    // CSRF: state-changing requests must come from an allowed origin and carry
    // a custom header, which browsers only send cross-origin after a CORS preflight.
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("Origin");
      const allowed = origin !== undefined && listVar(c.env.ALLOWED_ORIGINS).includes(origin);
      if (!allowed || c.req.header(ADMIN_HEADER) !== "1") return c.json({ error: "forbidden" }, 403);
    }

    c.set("session", session);
    await next();
  });

  // Cloudflare Access intercepts this navigation and runs the login flow; by the
  // time the request reaches the Worker the user is signed in, so send them back.
  app.get("/admin/login", (c) => {
    const origins = listVar(c.env.ALLOWED_ORIGINS);
    const fallback = `${origins[0] ?? new URL(c.req.url).origin}/biotech/admin/`;
    const requested = c.req.query("return");
    let target = fallback;
    if (requested) {
      try {
        if (origins.includes(new URL(requested).origin)) target = requested;
      } catch {
        // malformed return URL: use the fallback
      }
    }
    return c.redirect(target, 302);
  });

  app.get("/admin/session", (c) => c.json(c.get("session")));

  app.post("/admin/refresh/market", async (c) => {
    const result = await refreshPrices(c.env.DB, provider(c.env), { force: true });
    await writeAudit(c.env.DB, Math.floor(Date.now() / 1000), c.get("session").email, "refresh.market", `updated ${result.updated}, failed ${result.failed.length}`);
    return c.json(result);
  });

  app.post("/admin/refresh/profiles", async (c) => {
    const result = await refreshProfiles(c.env.DB, provider(c.env));
    await writeAudit(c.env.DB, Math.floor(Date.now() / 1000), c.get("session").email, "refresh.profiles", `updated ${result.updated}, failed ${result.failed.length}`);
    return c.json(result);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    // UpstreamError messages are built from an error kind and status only. For
    // anything else, log the error class but not its message.
    console.error(err instanceof UpstreamError ? err.message : `unhandled ${err.name}`);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
