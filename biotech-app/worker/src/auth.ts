import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AdminSession } from "../../shared/types";
import { listVar, type Env } from "./env";

// Authentication is delegated to Cloudflare Access: it handles login and issues
// a signed JWT. This module only verifies that token with `jose` and applies
// the administrator allow-list. No passwords or session crypto live here.

const jwksByDomain = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = jwksByDomain.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByDomain.set(teamDomain, keys);
  }
  return keys;
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

export interface AuthDeps {
  /** Overrides key lookup in tests. */
  getKey?: JWTVerifyGetKey;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Resolves the admin session, or null. Fails closed on any missing configuration. */
export async function authenticate(request: Request, env: Env, deps: AuthDeps = {}): Promise<AdminSession | null> {
  const admins = listVar(env.ADMIN_EMAILS).map((e) => e.toLowerCase());

  if (env.DEV_ADMIN_EMAIL && LOCAL_HOSTS.has(new URL(request.url).hostname)) {
    return { email: env.DEV_ADMIN_EMAIL.toLowerCase() };
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "");
  if (!teamDomain || !env.ACCESS_AUD || admins.length === 0) return null;

  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? readCookie(request.headers.get("Cookie"), "CF_Authorization");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, deps.getKey ?? remoteKeys(teamDomain), {
      issuer: teamDomain,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    return email && admins.includes(email) ? { email } : null;
  } catch {
    return null;
  }
}
