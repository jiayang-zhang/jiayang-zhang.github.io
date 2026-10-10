import { dashboardConfig } from "../../shared/config";

export function formatTimestamp(unixSeconds: number | null | undefined): string {
  if (typeof unixSeconds !== "number") return "never";
  return new Date(unixSeconds * 1000).toLocaleString(dashboardConfig.display.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
