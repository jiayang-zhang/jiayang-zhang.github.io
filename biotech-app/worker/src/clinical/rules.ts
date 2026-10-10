import { z } from "zod";
import { dashboardConfig } from "../../../shared/config";
import { EVENT_CATEGORIES, EVIDENCE_BASES, categoryPhase, isIsoDate, type EventCategory, type EvidenceBasis, type TerminationReason, type TrialPhase } from "../../../shared/events";
import { containsExcerpt } from "./text";

// ---- Classifier output ----

export const classifiedEventSchema = z.object({
  category: z.enum(EVENT_CATEGORIES).nullable(),
  trialPhase: z.enum(["1/2", "2", "2/3", "3", "other"]).nullable(),
  /** For combined trials: which part of the trial the announcement is about. */
  portion: z.enum(["phase2", "phase3", "unclear"]).nullable(),
  program: z.string().nullable(),
  indication: z.string().nullable(),
  nctId: z.string().nullable(),
  evidenceBasis: z.enum(EVIDENCE_BASES).nullable(),
  terminationReason: z.enum(["futility", "safety", "commercial", "administrative", "unknown"]).nullable(),
  summary: z.string().nullable(),
  supportingExcerpt: z.string().nullable(),
  eventDate: z.string().nullable(),
  needsHumanReview: z.boolean(),
  reviewReason: z.string().nullable(),
});

export const classificationSchema = z.object({
  events: z.array(classifiedEventSchema).max(6),
  notQualifyingReason: z.string().nullable(),
});

export type ClassifiedEvent = z.infer<typeof classifiedEventSchema>;
export type Classification = z.infer<typeof classificationSchema>;

export interface EventDraft {
  category: EventCategory | null;
  phase: TrialPhase | null;
  program: string | null;
  indication: string | null;
  nctId: string | null;
  evidenceBasis: EvidenceBasis | null;
  terminationReason: TerminationReason | null;
  summary: string | null;
  excerpt: string | null;
  eventDate: string | null;
  note: string | null;
}

export type Evaluation =
  /** A categorised event, saved as pending review. */
  | { outcome: "event"; draft: EventDraft & { category: EventCategory } }
  /** Evidence is insufficient or ambiguous: saved uncategorised for a person to decide. */
  | { outcome: "review"; draft: EventDraft }
  /** Not a qualifying event under the taxonomy; recorded with the reason, never shown. */
  | { outcome: "excluded"; reason: string }
  /** The classifier's output cannot be trusted; nothing is created from it. */
  | { outcome: "rejected"; reason: string };

const NCT = /^NCT\d{8}$/;

/**
 * Applies the taxonomy's rules to one classifier result. The classifier
 * proposes; this function decides what may be stored, and nothing it returns
 * is ever saved as verified.
 */
export function evaluateClassification(item: ClassifiedEvent, sourceText: string, includePhase1_2 = dashboardConfig.clinical.includePhase1_2Trials): Evaluation {
  if (!item.supportingExcerpt || !containsExcerpt(sourceText, item.supportingExcerpt)) {
    return { outcome: "rejected", reason: "Supporting excerpt does not appear in the source text" };
  }

  const nctId = item.nctId && NCT.test(item.nctId) && sourceText.includes(item.nctId) ? item.nctId : null;
  const draft: EventDraft = {
    category: item.category,
    phase: item.trialPhase === "other" ? null : item.trialPhase,
    program: item.program?.trim().slice(0, 200) || null,
    indication: item.indication?.trim().slice(0, 300) || null,
    nctId,
    evidenceBasis: item.evidenceBasis,
    terminationReason: item.terminationReason,
    summary: item.summary?.trim().slice(0, 600) || null,
    excerpt: item.supportingExcerpt.trim().slice(0, 1500),
    eventDate: isIsoDate(item.eventDate) ? item.eventDate : null,
    note: item.reviewReason?.trim().slice(0, 300) || null,
  };
  const review = (note: string): Evaluation => ({ outcome: "review", draft: { ...draft, category: null, note } });

  if (item.terminationReason === "commercial" || item.terminationReason === "administrative") {
    return { outcome: "excluded", reason: `Terminated for ${item.terminationReason} reasons, which is not a clinical failure` };
  }
  if (item.trialPhase === null || item.trialPhase === "other") return { outcome: "excluded", reason: "Not a Phase II or Phase III trial" };
  if (item.trialPhase === "1/2") {
    if (!includePhase1_2) return { outcome: "excluded", reason: "Phase I/II trials are excluded by configuration" };
    if (item.portion !== "phase2") return { outcome: "excluded", reason: "Phase I/II announcement does not concern the Phase II portion" };
  }
  if (item.trialPhase === "2/3" && (item.portion === null || item.portion === "unclear")) {
    return review("Phase II/III trial: the announcement does not make clear which portion it concerns");
  }
  if (item.needsHumanReview || item.category === null) return review(draft.note ?? "Classifier could not assign a category");
  if (!draft.program || !draft.summary) return review("Classifier omitted the programme or summary");

  const expected = item.trialPhase === "3" || (item.trialPhase === "2/3" && item.portion === "phase3") ? "3" : "2";
  if (categoryPhase(item.category) !== expected) return review(`Category ${item.category} does not match a Phase ${expected === "3" ? "III" : "II"} announcement`);

  const basis = item.evidenceBasis;
  if (item.category === "phase3_initiation") {
    if (basis !== "initiation_announced" && basis !== "registry_status") return review("Initiation without a stated start or first-patient event");
  } else if (item.category.endsWith("success")) {
    // Completion or enrolment alone is never success: a stated result is required.
    if (basis !== "primary_endpoint_met" && basis !== "company_characterised") return review("Success without a stated result");
  } else {
    if (basis === "termination") {
      if (item.terminationReason !== "futility" && item.terminationReason !== "safety") return review("Trial terminated, reason not established");
    } else if (basis !== "primary_endpoint_not_met" && basis !== "company_characterised") {
      return review("Failure without a stated result");
    }
  }

  return { outcome: "event", draft: { ...draft, category: item.category } };
}

// ---- Registry status changes ----

const NOT_A_FAILURE = /not (based on|due to|related to|because of|driven by)[^.]*(safety|efficacy)|business|strategic|commercial|portfolio|priorit|funding|financial|sponsor(?:'s)? decision|administrative|recruit|enrol|accrual|feasib|logistic|resourc|supply|merger|acquisition|licens/i;
const FUTILITY = /futil|lack of efficacy|insufficient efficacy|no (clinical |meaningful )?(benefit|efficacy)|did not meet|failed to (meet|demonstrate|show)|unlikely to (meet|demonstrate|show)|inefficac/i;
const SAFETY = /safety|adverse|toxicit|risk[- ]benefit|benefit[- ]risk|death|hepat|clinical hold/i;

/** Reads the registry's free-text "why stopped" field. Commercial and administrative wording is checked first. */
export function classifyTerminationReason(whyStopped: string | null | undefined): TerminationReason {
  const text = (whyStopped ?? "").trim();
  if (!text) return "unknown";
  if (NOT_A_FAILURE.test(text) && !FUTILITY.test(text)) return /administrative|recruit|enrol|accrual|feasib|logistic|supply/i.test(text) ? "administrative" : "commercial";
  if (FUTILITY.test(text)) return "futility";
  if (SAFETY.test(text)) return "safety";
  return "unknown";
}

export type RegistrySignal =
  | { kind: "none"; reason: string }
  | { kind: "excluded"; reason: string }
  | { kind: "review"; category: EventCategory | null; evidenceBasis: EvidenceBasis; terminationReason: TerminationReason | null; note: string };

const STARTED = new Set(["RECRUITING", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING"]);
const STOPPED = new Set(["TERMINATED", "SUSPENDED", "WITHDRAWN"]);

/**
 * Interprets a registry status change. A change is a prompt to investigate,
 * never proof: at most it produces a pending item for review.
 */
export function registrySignal(previousStatus: string | null, status: string, phases: string[], whyStopped: string | null): RegistrySignal {
  if (previousStatus === null) return { kind: "none", reason: "First sighting; recorded as baseline" };
  if (previousStatus === status) return { kind: "none", reason: "Status unchanged" };
  const combined = phases.includes("PHASE2") && phases.includes("PHASE3");
  const phase3 = phases.includes("PHASE3");

  if (status === "COMPLETED") return { kind: "none", reason: "Completion is not a result" };

  if (STARTED.has(status) && previousStatus === "NOT_YET_RECRUITING") {
    if (!phase3) return { kind: "none", reason: "Not a Phase III trial" };
    if (combined) return { kind: "review", category: null, evidenceBasis: "registry_status", terminationReason: null, note: "Phase II/III trial began recruiting; confirm whether the Phase III portion has started" };
    return { kind: "review", category: "phase3_initiation", evidenceBasis: "registry_status", terminationReason: null, note: `Registry status changed from ${previousStatus} to ${status}` };
  }

  if (STOPPED.has(status)) {
    const reason = classifyTerminationReason(whyStopped);
    if (reason === "commercial" || reason === "administrative") return { kind: "excluded", reason: `${status} for ${reason} reasons: ${(whyStopped ?? "").slice(0, 160)}` };
    const stated = whyStopped ? ` Registry reason: ${whyStopped.slice(0, 200)}` : " No reason given in the registry.";
    if (status !== "TERMINATED" || reason === "unknown" || combined) {
      return { kind: "review", category: null, evidenceBasis: "termination", terminationReason: reason, note: `Trial ${status.toLowerCase()}; evidence is insufficient to call it a failure.${stated}` };
    }
    return { kind: "review", category: phase3 ? "phase3_failure" : "phase2_failure", evidenceBasis: "termination", terminationReason: reason, note: `Trial terminated for ${reason}.${stated}` };
  }

  return { kind: "none", reason: `Status change ${previousStatus} to ${status} is not a tracked signal` };
}
