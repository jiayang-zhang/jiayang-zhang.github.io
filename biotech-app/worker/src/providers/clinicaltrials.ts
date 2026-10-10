import { z } from "zod";
import { dashboardConfig } from "../../../shared/config";
import type { WatchlistCompany } from "../../../shared/types";
import { dedupe, fetchJson } from "../lib/http";

// ClinicalTrials.gov API v2 (https://clinicaltrials.gov/data-api/api), checked 2026-10-10:
// - query.lead is a fuzzy search on the lead sponsor, so results are filtered
//   again against the configured sponsor names.
// - AREA[Phase](PHASE2 OR PHASE3) also returns PHASE1|PHASE2 studies.
// - primaryCompletionDateStruct.date is often month-precision (YYYY-MM), and
//   .type is ESTIMATED or ACTUAL.
// - Unknown field names are rejected with HTTP 400.

const studySchema = z.object({
  protocolSection: z.object({
    identificationModule: z.object({ nctId: z.string().regex(/^NCT\d{8}$/), briefTitle: z.string().optional() }),
    statusModule: z.object({
      overallStatus: z.string().optional(),
      primaryCompletionDateStruct: z.object({ date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/), type: z.string().optional() }).optional(),
    }),
    sponsorCollaboratorsModule: z.object({ leadSponsor: z.object({ name: z.string() }).optional() }).optional(),
    conditionsModule: z.object({ conditions: z.array(z.string()).optional() }).optional(),
    designModule: z.object({ phases: z.array(z.string()).optional() }).optional(),
    armsInterventionsModule: z.object({ interventions: z.array(z.object({ name: z.string(), type: z.string().optional() })).optional() }).optional(),
  }),
});

const pageSchema = z.object({ studies: z.array(studySchema), nextPageToken: z.string().optional() });

export interface RegistryReadout {
  ticker: string;
  nctId: string;
  title: string | null;
  phases: string[];
  overallStatus: string | null;
  dateStart: string;
  /** Set when the registry gives only a month: the last day of that month. */
  dateEnd: string | null;
  dateType: "ANTICIPATED" | "ACTUAL" | null;
  conditions: string[];
  interventions: string[];
}

export interface RegistryProvider {
  /** Phase II/III studies led by the company whose primary completion date is in [from, to]. */
  fetchReadouts(company: WatchlistCompany, from: string, to: string): Promise<RegistryReadout[]>;
}

const FIELDS = ["NCTId", "BriefTitle", "Phase", "OverallStatus", "PrimaryCompletionDate", "PrimaryCompletionDateType", "LeadSponsorName", "Condition", "InterventionName", "InterventionType"].join(",");
const MAX_PAGES = 5;
const NON_PROGRAMS = /\b(placebo|sham)\b|^(standard of care|best supportive care)\b/i;

/** Turns YYYY-MM or YYYY-MM-DD into a start date and, for a month, its last day. */
export function expandRegistryDate(date: string): { dateStart: string; dateEnd: string | null } {
  if (date.length === 10) return { dateStart: date, dateEnd: null };
  const [year, month] = date.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { dateStart: `${date}-01`, dateEnd: `${date}-${String(lastDay).padStart(2, "0")}` };
}

/** Phase II and III only. Phase I/II is excluded unless enabled in configuration. */
export function phaseQualifies(phases: string[], includePhase1_2 = dashboardConfig.clinical.includePhase1_2Trials): boolean {
  if (!phases.includes("PHASE2") && !phases.includes("PHASE3")) return false;
  if (phases.includes("PHASE1")) return includePhase1_2;
  return true;
}

export function sponsorMatches(company: WatchlistCompany, leadSponsor: string | undefined): boolean {
  if (!leadSponsor) return false;
  const name = leadSponsor.toLowerCase();
  return company.registrySponsors.some((s) => name.includes(s.toLowerCase()));
}

export function toReadout(company: WatchlistCompany, study: z.infer<typeof studySchema>): RegistryReadout | null {
  const p = study.protocolSection;
  const completion = p.statusModule.primaryCompletionDateStruct;
  const phases = p.designModule?.phases ?? [];
  if (!completion || !phaseQualifies(phases) || !sponsorMatches(company, p.sponsorCollaboratorsModule?.leadSponsor?.name)) return null;
  const type = completion.type?.toUpperCase();
  return {
    ticker: company.ticker,
    nctId: p.identificationModule.nctId,
    title: p.identificationModule.briefTitle ?? null,
    phases,
    overallStatus: p.statusModule.overallStatus ?? null,
    ...expandRegistryDate(completion.date),
    dateType: type === "ACTUAL" ? "ACTUAL" : type === "ESTIMATED" || type === "ANTICIPATED" ? "ANTICIPATED" : null,
    conditions: p.conditionsModule?.conditions ?? [],
    interventions: (p.armsInterventionsModule?.interventions ?? []).map((i) => i.name).filter((n) => !NON_PROGRAMS.test(n)),
  };
}

export function createClinicalTrialsProvider(deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): RegistryProvider {
  const { baseUrl } = dashboardConfig.providers.clinicalTrials;
  const { timeoutMs, retries, backoffBaseMs } = dashboardConfig.network;
  return {
    fetchReadouts(company, from, to) {
      return dedupe(`ctgov:${company.ticker}:${from}:${to}`, async () => {
        const out: RegistryReadout[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const params = new URLSearchParams({
            "query.lead": company.registrySponsors[0] ?? company.name,
            "filter.advanced": `AREA[Phase](PHASE2 OR PHASE3) AND AREA[PrimaryCompletionDate]RANGE[${from},${to}]`,
            fields: FIELDS,
            pageSize: "200",
          });
          if (pageToken) params.set("pageToken", pageToken);
          const body = await fetchJson(`${baseUrl}/studies?${params}`, { schema: pageSchema, timeoutMs, retries, backoffBaseMs, ...deps });
          for (const study of body.studies) {
            const readout = toReadout(company, study);
            if (readout) out.push(readout);
          }
          pageToken = body.nextPageToken;
          if (!pageToken) break;
        }
        return out;
      });
    },
  };
}
