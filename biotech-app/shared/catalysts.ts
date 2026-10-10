import { dashboardConfig } from "./config";
import type { Catalyst, CatalystStatus, CatalystType } from "./types";

export const CATALYST_TYPE_LABELS: Record<CatalystType, string> = {
  pdufa: "PDUFA date",
  readout: "Data readout",
  adcom: "Advisory committee",
};

export const CATALYST_STATUS_LABELS: Record<CatalystStatus, string> = {
  confirmed: "Confirmed",
  estimated: "Estimated",
  unverified: "Unverified",
};

export const REGISTRY_NOTE =
  "Primary completion date: when final data collection for the primary endpoint is expected, not when results will be announced. Readouts often come later.";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for real calendar dates written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return utcDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface CatalystTiming {
  /** Days from today to the start date; negative once it has passed. */
  daysUntil: number;
  /** The whole event (or range) lies in the past. */
  overdue: boolean;
  /** Today falls inside the event's date range. */
  ongoing: boolean;
  /** Starts, or if already under way ends, within the highlight window (seven days by default). */
  imminent: boolean;
  label: string;
}

export function catalystTiming(c: Pick<Catalyst, "dateStart" | "dateEnd">, today: string): CatalystTiming {
  const daysUntil = daysBetween(today, c.dateStart);
  const end = c.dateEnd ?? c.dateStart;
  const overdue = end < today;
  const ongoing = !overdue && daysUntil <= 0;
  // A range already under way counts only when it also ends within the window,
  // so a month-long registry estimate is not flagged for the whole month.
  const within = dashboardConfig.catalysts.highlightWithinDays;
  const imminent = !overdue && (daysUntil >= 0 ? daysUntil <= within : daysBetween(today, end) <= within);
  let label: string;
  if (overdue) {
    const late = daysBetween(end, today);
    label = `Overdue by ${late} day${late === 1 ? "" : "s"}`;
  } else if (daysUntil === 0) label = "Today";
  else if (ongoing) label = "In window now";
  else label = `In ${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
  return { daysUntil, overdue, ongoing, imminent, label };
}

/** Within the look-ahead window, or past but still inside the overdue grace period. */
export function inFeedWindow(c: Pick<Catalyst, "dateStart" | "dateEnd">, today: string): boolean {
  const { lookAheadDays, overdueGraceDays } = dashboardConfig.catalysts;
  return c.dateStart <= addDays(today, lookAheadDays) && (c.dateEnd ?? c.dateStart) >= addDays(today, -overdueGraceDays);
}

export function dateRecentlyChanged(c: Pick<Catalyst, "previousDateStart" | "dateChangedAt">, nowSeconds: number): boolean {
  if (!c.previousDateStart || c.dateChangedAt === null) return false;
  return nowSeconds - c.dateChangedAt <= dashboardConfig.catalysts.dateChangedLabelDays * 86_400;
}

/**
 * A manual entry for a trial replaces the registry estimate for the same
 * trial (matched by NCT number), wherever the manual entry's date falls.
 */
export function applyManualOverrides<T extends Pick<Catalyst, "origin" | "nctId">>(all: T[]): T[] {
  const manualTrials = new Set(all.filter((c) => c.origin === "manual" && c.nctId).map((c) => c.nctId));
  return all.filter((c) => c.origin !== "registry" || !manualTrials.has(c.nctId));
}

export function sortChronologically<T extends Pick<Catalyst, "dateStart" | "ticker" | "id">>(items: T[]): T[] {
  return [...items].sort((a, b) => a.dateStart.localeCompare(b.dateStart) || a.ticker.localeCompare(b.ticker) || a.id.localeCompare(b.id));
}

export function formatCatalystDate(c: Pick<Catalyst, "dateStart" | "dateEnd">): string {
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(dashboardConfig.display.locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return c.dateEnd && c.dateEnd !== c.dateStart ? `${fmt(c.dateStart)} – ${fmt(c.dateEnd)}` : fmt(c.dateStart);
}
