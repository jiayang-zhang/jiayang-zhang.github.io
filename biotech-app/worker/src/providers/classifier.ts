import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { dashboardConfig } from "../../../shared/config";
import { classificationSchema } from "../clinical/rules";
import { UpstreamError } from "../lib/http";

export interface ClassifierInput {
  ticker: string;
  companyName: string;
  aliases: string[];
  sourceLabel: string;
  publishedDate: string;
  text: string;
}

export interface ClassifierResult {
  /** Unvalidated model output; the caller validates it against the schema and the source text. */
  output: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Classifier {
  readonly model: string;
  classify(input: ClassifierInput): Promise<ClassifierResult>;
}

export const SYSTEM_PROMPT = `You extract clinical trial events from one company disclosure (an SEC filing or press release) for an investment research dashboard. A person reviews everything you return, so report what the document says and flag doubt instead of guessing.

Return every qualifying event in the document that concerns the named company's own or partnered programmes. Return an empty list when there is none, with a short reason.

There are exactly five event categories:
- phase2_success: a Phase II trial's primary endpoint was met.
- phase2_failure: a Phase II trial's primary endpoint was not met, or the trial was stopped for futility or safety.
- phase3_initiation: a Phase III trial's start was announced, or its first patient was dosed or enrolled.
- phase3_success: a Phase III trial's primary endpoint was met.
- phase3_failure: a Phase III trial's primary endpoint was not met, or the trial was stopped for futility or safety.

Rules:
- A trial that completed, finished enrolment or reached a recruitment target has not succeeded. Without a stated efficacy result it is not an event.
- A trial stopped for commercial, strategic, portfolio, funding or administrative reasons is not a failure. Return it with terminationReason "commercial" or "administrative" so it can be recorded as excluded. If a trial was stopped and the reason is not stated, use terminationReason "unknown" and set needsHumanReview.
- evidenceBasis records what the document actually states. Use primary_endpoint_met or primary_endpoint_not_met only when the document says so about the primary endpoint. When the company calls results positive or negative without stating the primary endpoint result (for example "positive topline data"), use company_characterised. Use initiation_announced for a Phase III start and termination for a stopped trial.
- trialPhase is the trial's registered design: "2", "3", "2/3" for a combined Phase II/III trial, "1/2" for Phase I/II, "other" for anything else (Phase I, Phase IV, preclinical, observational).
- For a "2/3" or "1/2" trial, portion says which part the announcement is about. A readout from the Phase II part is a Phase II event; moving into the Phase III part is a Phase III initiation; a pivotal readout is a Phase III event. If the document does not make this clear, set portion to "unclear" and needsHumanReview to true.
- Ignore events that are only background: results reported in an earlier period and repeated in an earnings summary, pipeline tables, or plans for future trials with no start announced.
- Ignore regulatory events (approvals, submissions, designations) and trials run by unrelated companies.
- nctId: the NCT number only if it is written in the document; otherwise null. Never supply one from memory.
- program: the drug or programme name as written. indication: the disease studied.
- summary: one factual sentence, no adjectives of your own, no investment view.
- supportingExcerpt: one passage copied character for character from the document that supports the category and evidence basis. Do not paraphrase, join separate passages or correct typos; an excerpt that is not found in the document is discarded.
- eventDate: the date the result or start occurred, as YYYY-MM-DD, only if the document states one that differs from its publication date; otherwise null.
- Set needsHumanReview to true whenever the category depends on a judgement the document does not settle, and say why in reviewReason.`;

function userMessage(input: ClassifierInput): string {
  const names = [input.companyName, ...input.aliases].join("; ");
  return `Company: ${input.companyName} (${input.ticker}). Also known as or owning: ${names}.
Source: ${input.sourceLabel}, published ${input.publishedDate}.

<document>
${input.text}
</document>`;
}

export function createAnthropicClassifier(apiKey: string | undefined, deps: { client?: Anthropic } = {}): Classifier | null {
  if (!apiKey && !deps.client) return null;
  const client = deps.client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  const model = dashboardConfig.clinical.llmModel;

  return {
    model,
    async classify(input) {
      try {
        // Biomedical text can trip the model's safety classifiers. The server-side
        // fallback re-runs a declined request on another model within the same call.
        const response = await client.beta.messages.parse({
          model,
          max_tokens: 8000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage(input) }],
          output_config: { effort: dashboardConfig.clinical.llmEffort, format: betaZodOutputFormat(classificationSchema) },
        });
        // A refusal or a cut-off response carries no usable classification; the
        // document is retried and, failing that, goes to manual review.
        if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") throw new UpstreamError("invalid");
        return {
          output: response.parsed_output,
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        // Map SDK errors to kinds that are safe to log and store.
        if (err instanceof Anthropic.RateLimitError) throw new UpstreamError("rate_limited", 429);
        if (err instanceof Anthropic.APIConnectionError) throw new UpstreamError("network");
        if (err instanceof Anthropic.APIError) throw new UpstreamError("http", typeof err.status === "number" ? err.status : undefined);
        throw new UpstreamError("invalid");
      }
    },
  };
}
