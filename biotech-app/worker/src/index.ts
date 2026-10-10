import { createApp } from "./app";
import type { Env } from "./env";
import { UpstreamError } from "./lib/http";
import { createMarketDataProvider } from "./providers";
import { createClinicalTrialsProvider } from "./providers/clinicaltrials";
import { syncRegistryCatalysts } from "./services/catalysts";
import { refreshPrices, refreshProfiles } from "./services/market";

const app = createApp();

// Must match the cron expressions in wrangler.toml.
const PROFILES_CRON = "7 12 * * 1-5";
const CATALYSTS_CRON = "23 * * * *";

async function runScheduled(cron: string, env: Env): Promise<void> {
  try {
    const provider = createMarketDataProvider(env);
    if (cron === CATALYSTS_CRON) await syncRegistryCatalysts(env.DB, createClinicalTrialsProvider());
    else if (cron === PROFILES_CRON) await refreshProfiles(env.DB, provider);
    else await refreshPrices(env.DB, provider);
  } catch (err) {
    console.error(err instanceof UpstreamError ? err.message : `scheduled job failed: ${err instanceof Error ? err.name : "error"}`);
  }
}

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;
