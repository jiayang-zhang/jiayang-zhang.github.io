import { isIsoDate } from "./catalysts";

export const EVENT_CATEGORIES = ["phase2_success", "phase2_failure", "phase3_initiation", "phase3_success", "phase3_failure"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  phase2_success: "Phase II success",
  phase2_failure: "Phase II failure",
  phase3_initiation: "Phase III initiation",
  phase3_success: "Phase III success",
  phase3_failure: "Phase III failure",
};

export type EventTone = "success" | "failure" | "initiation";
export const EVENT_TONES: Record<EventCategory, EventTone> = {
  phase2_success: "success",
  phase2_failure: "failure",
  phase3_initiation: "initiation",
  phase3_success: "success",
  phase3_failure: "failure",
};

export const EVIDENCE_BASES = ["primary_endpoint_met", "primary_endpoint_not_met", "company_characterised", "initiation_announced", "registry_status", "termination"] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

export const EVIDENCE_LABELS: Record<EvidenceBasis, string> = {
  primary_endpoint_met: "Primary endpoint met",
  primary_endpoint_not_met: "Primary endpoint not met",
  company_characterised: "Company-characterised",
  initiation_announced: "Initiation announced",
  registry_status: "Registry status change",
  termination: "Trial terminated",
};

export const TRIAL_PHASES = ["1/2", "2", "2/3", "3"] as const;
export type TrialPhase = (typeof TRIAL_PHASES)[number];
export const TRIAL_PHASE_LABELS: Record<TrialPhase, string> = { "1/2": "Phase I/II", "2": "Phase II", "2/3": "Phase II/III", "3": "Phase III" };

export type TerminationReason = "futility" | "safety" | "commercial" | "administrative" | "unknown";
export type ReviewStatus = "pending" | "verified" | "rejected";
export type SourceKind = "edgar" | "news" | "registry";

/** Higher is more authoritative; the highest-ranked source is shown as primary. */
export const SOURCE_AUTHORITY: Record<SourceKind, number> = { edgar: 3, news: 2, registry: 1 };
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = { edgar: "SEC filing", news: "Press release", registry: "ClinicalTrials.gov" };

export interface EventSource {
  kind: SourceKind;
  url: string;
  label: string;
  date: string | null;
}

/** What visitors receive. Never includes rejected events or review-only fields. */
export interface ClinicalEvent {
  id: string;
  ticker: string;
  category: EventCategory;
  phase: TrialPhase | null;
  program: string;
  indication: string | null;
  summary: string;
  evidenceBasis: EvidenceBasis;
  nctId: string | null;
  /** When the result or initiation was announced. */
  announcementDate: string;
  /** When the underlying event happened, if stated and different. */
  eventDate: string | null;
  /** "unreviewed" marks an automated classification no person has confirmed. */
  verification: "verified" | "unreviewed";
  /** When the source was last fetched; distinct from the announcement date. */
  lastRetrievedAt: number;
  primarySource: EventSource | null;
  sources: EventSource[];
}

export interface ClinicalFeed {
  items: ClinicalEvent[];
  total: number;
  nextOffset: number | null;
  showsUnreviewed: boolean;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastRefreshFailed: boolean;
}

/** Admin review item: an event or an unclassified candidate, with its evidence. */
export interface ReviewItem {
  id: string;
  ticker: string;
  category: EventCategory | null;
  phase: TrialPhase | null;
  program: string | null;
  indication: string | null;
  summary: string | null;
  evidenceBasis: EvidenceBasis | null;
  nctId: string | null;
  announcementDate: string;
  eventDate: string | null;
  status: ReviewStatus;
  excerpt: string | null;
  /** Why the item needs attention, or how it was classified. */
  note: string | null;
  terminationReason: TerminationReason | null;
  origin: "llm" | "manual" | "registry";
  model: string | null;
  promptVersion: string | null;
  truncated: boolean;
  lastRetrievedAt: number;
  reviewedAt: number | null;
  sources: EventSource[];
}

export interface ReviewInput {
  category: EventCategory;
  phase?: TrialPhase | null;
  program: string;
  indication?: string | null;
  summary: string;
  evidenceBasis: EvidenceBasis;
  nctId?: string | null;
  announcementDate: string;
  eventDate?: string | null;
}

export function categoryPhase(category: EventCategory): "2" | "3" {
  return category.startsWith("phase2") ? "2" : "3";
}

/** Verified events always show; pending ones only when configured, flagged unreviewed; rejected never. */
export function publicVerification(status: ReviewStatus, category: EventCategory | null, showUnreviewed: boolean): "verified" | "unreviewed" | null {
  if (category === null) return null;
  if (status === "verified") return "verified";
  if (status === "pending" && showUnreviewed) return "unreviewed";
  return null;
}

/** Comparison key for programme and indication names: "VK-2735" and "VK2735" are the same programme. */
export function normaliseName(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export { isIsoDate };
