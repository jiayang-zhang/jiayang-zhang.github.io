export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;

  // Secrets (wrangler secret put ...). Never logged, never returned to clients.
  FINNHUB_API_KEY?: string;

  // Cloudflare Access: team domain (https://<team>.cloudflareaccess.com) and
  // the application audience tag. Admin routes fail closed when unset.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Comma-separated allow-list of administrator emails. */
  ADMIN_EMAILS?: string;

  /** Comma-separated origins allowed to call the API from a browser. */
  ALLOWED_ORIGINS?: string;
  /** "live" (default) or "mock". Mock data is always labelled as such. */
  DATA_MODE?: string;
  /** Local development only: grants an admin session on localhost. */
  DEV_ADMIN_EMAIL?: string;

  WRITE_LIMITER?: RateLimiterBinding;
}

export function listVar(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
