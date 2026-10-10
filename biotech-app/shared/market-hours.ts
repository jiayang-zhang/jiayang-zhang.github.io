import { dashboardConfig } from "./config";

interface LocalParts {
  date: string; // YYYY-MM-DD in the exchange time zone
  weekday: number; // 0 = Sunday
  minutes: number; // minutes after local midnight
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function exchangeParts(at: Date): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: dashboardConfig.market.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAYS.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Regular US session, Monday to Friday. Exchange holidays and early closes are
 * not modelled: on those days the job polls and receives unchanged quotes.
 */
export function isUsMarketOpen(at: Date): boolean {
  const p = exchangeParts(at);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.minutes >= dashboardConfig.market.sessionOpenMinutes && p.minutes < dashboardConfig.market.sessionCloseMinutes;
}

/** Trading date (exchange time zone) for a Unix-seconds timestamp. */
export function exchangeDate(unixSeconds: number): string {
  return exchangeParts(new Date(unixSeconds * 1000)).date;
}
