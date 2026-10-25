export const FARM_TIME_ZONE = "Asia/Manila";

// Formats as short time (e.g. "3:42 PM"); returns "N/A" on invalid input.
export function formatFarmTime(value: Date | string | null | undefined): string {
  if (!value) return "N/A";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  try {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: FARM_TIME_ZONE,
    });
  } catch {
    return d.toLocaleTimeString();
  }
}

function getFarmDateParts(d: Date): { month: string; day: string; year: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: FARM_TIME_ZONE,
  }).formatToParts(d);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { month: pick("month"), day: pick("day"), year: pick("year") };
}

// Formats as a plain date (e.g. "September 12 2026"); returns "N/A" on invalid input.
export function formatFarmDate(value: Date | string | null | undefined): string {
  if (!value) return "N/A";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  try {
    const { month, day, year } = getFarmDateParts(d);
    return `${month} ${day} ${year}`;
  } catch {
    return d.toLocaleDateString();
  }
}

// Formats as a full date+time (e.g. "September 12 2026, 3:42 PM"); returns "N/A" on invalid input.
export function formatFarmDateTime(value: Date | string | null | undefined): string {
  if (!value) return "N/A";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  try {
    const { month, day, year } = getFarmDateParts(d);
    const timeParts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: FARM_TIME_ZONE,
    }).formatToParts(d);
    const pick = (type: string) => timeParts.find((p) => p.type === type)?.value ?? "";
    return `${month} ${day} ${year}, ${pick("hour")}:${pick("minute")} ${pick("dayPeriod")}`;
  } catch {
    return d.toLocaleString();
  }
}

// The farm is Asia/Manila, which is a fixed UTC+8 offset with no daylight
// saving. That is why the date-picker boundaries below can be built with a
// literal "+08:00" instead of pulling in a timezone library or asking Intl to
// round-trip an offset (which it cannot do directly).
const FARM_UTC_OFFSET = "+08:00";

// "2026-08-25" -> Date at 00:00:00 farm time (that day's first instant).
// Returns null for anything that is not a plain YYYY-MM-DD date, so a cleared
// or half-typed picker value can never be sent to the server as a valid bound.
export function farmDateToStart(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00${FARM_UTC_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "2026-08-31" -> Date at 00:00 farm time on Sep 1, i.e. the *exclusive* end of
// the chosen day. Callers filter with `timestamp < end`, so the last day is
// included without a 23:59:59.999 fudge that would drop the final readings of
// a second-granularity tank.
export function farmDateToEndExclusive(value: string | null | undefined): Date | null {
  const start = farmDateToStart(value);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

// An instant -> "YYYY-MM-DD" as the farm sees it, i.e. the value an
// <input type="date"> expects. Prefilling the custom-range picker this way means
// it opens on a week of real readings rather than a blank form (or the browser's
// own timezone's idea of today, which can be a day off from the farm's).
export function farmDateInputValue(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: FARM_TIME_ZONE,
    }).formatToParts(d);
    const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${pick("year")}-${pick("month")}-${pick("day")}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// Relative age of a timestamp, e.g. "5s ago", "3m ago"; "N/A" on invalid input.
export function formatTimeAgo(timestamp: string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(date.getTime())) return "N/A";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
