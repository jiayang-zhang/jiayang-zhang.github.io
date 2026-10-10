import { z } from "zod";
import { dashboardConfig } from "../../../shared/config";
import type { WatchlistCompany } from "../../../shared/types";
import { htmlToText } from "../clinical/text";
import { dedupe, fetchJson, fetchText, UpstreamError } from "../lib/http";

// SEC EDGAR (https://www.sec.gov/os/accessing-edgar-data), checked 2026-10-10:
// - data.sec.gov/submissions/CIK##########.json lists the latest ~1,000 filings
//   as parallel arrays, with 8-K item codes and a document description.
// - Each filing's folder has an index.json naming its files; press releases
//   are exhibits whose file names contain "ex99".
// - SEC requires a User-Agent identifying the caller with contact details and
//   allows at most 10 requests a second. This module makes requests one at a time.

const submissionsSchema = z.object({
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      filingDate: z.array(z.string()),
      form: z.array(z.string()),
      primaryDocument: z.array(z.string()),
      items: z.array(z.string()).optional(),
      primaryDocDescription: z.array(z.string()).optional(),
    }),
  }),
});

const indexSchema = z.object({ directory: z.object({ item: z.array(z.object({ name: z.string() })) }) });

export interface FilingRef {
  ticker: string;
  cik: number;
  form: string;
  accession: string;
  filingDate: string;
  primaryDocument: string;
  items: string;
  description: string;
}

export interface EdgarProvider {
  /** Filings of the company's disclosure form (8-K or 6-K, with amendments) on or after `since`. */
  listFilings(company: WatchlistCompany, since: string): Promise<FilingRef[]>;
  /** Text of the filing's main document and its first press-release exhibit. */
  fetchFilingText(ref: Pick<FilingRef, "cik" | "accession" | "primaryDocument">): Promise<string>;
}

export function filingFolder(cik: number, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}`;
}

/** Human-readable filing index page, used as the public source link. */
export function filingUrl(cik: number, accession: string): string {
  return `${filingFolder(cik, accession)}/${accession}-index.htm`;
}

const EXHIBIT_99 = /ex[-_]?99.*\.html?$/i;

export function pickDocuments(files: string[], primaryDocument: string): string[] {
  const exhibit = files.find((f) => EXHIBIT_99.test(f) && f !== primaryDocument);
  return exhibit ? [primaryDocument, exhibit] : [primaryDocument];
}

export function createEdgarProvider(userAgent: string | undefined, deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): EdgarProvider {
  const { timeoutMs, retries, backoffBaseMs } = dashboardConfig.network;
  const options = () => {
    if (!userAgent || !userAgent.includes("@")) throw new UpstreamError("config");
    return { headers: { "User-Agent": userAgent, "Accept-Encoding": "gzip, deflate" }, timeoutMs, retries, backoffBaseMs, ...deps };
  };

  return {
    listFilings(company, since) {
      return dedupe(`edgar:list:${company.cik}`, async () => {
        const cik = String(company.cik).padStart(10, "0");
        const body = await fetchJson(`${dashboardConfig.providers.edgar.baseUrl}/submissions/CIK${cik}.json`, { schema: submissionsSchema, ...options() });
        const r = body.filings.recent;
        const out: FilingRef[] = [];
        for (let i = 0; i < r.form.length; i++) {
          const form = r.form[i]!;
          const filingDate = r.filingDate[i] ?? "";
          if (!(form === company.filerType || form === `${company.filerType}/A`) || filingDate < since) continue;
          out.push({
            ticker: company.ticker,
            cik: company.cik,
            form,
            accession: r.accessionNumber[i] ?? "",
            filingDate,
            primaryDocument: r.primaryDocument[i] ?? "",
            items: r.items?.[i] ?? "",
            description: r.primaryDocDescription?.[i] ?? "",
          });
        }
        return out.filter((f) => f.accession && f.primaryDocument);
      });
    },

    async fetchFilingText(ref) {
      const folder = filingFolder(ref.cik, ref.accession);
      const index = await fetchJson(`${folder}/index.json`, { schema: indexSchema, ...options() });
      const parts: string[] = [];
      for (const name of pickDocuments(index.directory.item.map((f) => f.name), ref.primaryDocument)) {
        parts.push(htmlToText(await fetchText(`${folder}/${encodeURIComponent(name)}`, options())));
      }
      return parts.join("\n\n");
    },
  };
}
