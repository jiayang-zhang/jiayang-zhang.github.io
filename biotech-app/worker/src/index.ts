import { createApp, defaultClinicalDeps } from "./app";
import type { Env } from "./env";
import { UpstreamError } from "./lib/http";
import { createMarketDataProvider } from "./providers";
import { createClinicalTrialsProvider, createTrialStatusProvider } from "./providers/clinicaltrials";
import { runClinicalCycle, syncTrialSignals } from "./services/clinical";
import { syncRegistryCatalysts } from "./services/catalysts";
import { refreshPrices, refreshProfiles } from "./services/market";

const app = createApp();

// Must match the cron expressions in wrangler.toml. Weekdays are named there
// because Cloudflare numbers them from Sunday = 1, so "1-5" is not Monday-Friday.
// Matched on minute and hour only, in case the day field is reported in another form.
const PROFILES_CRON = "7 12 ";
const CATALYSTS_CRON = "23 * * * *";
const CLINICAL_CRON = "*/15 * * * *";

async function runScheduled(cron: string, env: Env): Promise<void> {
  try {
    const provider = createMarketDataProvider(env);
    if (cron === CLINICAL_CRON) await runClinicalCycle(env.DB, defaultClinicalDeps(env));
    else if (cron === CATALYSTS_CRON) {
      // Both read ClinicalTrials.gov; a failure in one must not skip the other.
      await Promise.allSettled([syncRegistryCatalysts(env.DB, createClinicalTrialsProvider()), syncTrialSignals(env.DB, createTrialStatusProvider())]);
    } else if (cron.startsWith(PROFILES_CRON)) await refreshProfiles(env.DB, provider);
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
