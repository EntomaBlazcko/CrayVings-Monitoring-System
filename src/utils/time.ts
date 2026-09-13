// =============================================================================
// FILE: src/utils/time.ts
// =============================================================================
// Time formatting helpers that render timestamps in the farm's timezone (Asia/Manila).
// Dates render as "September 12 2026" and datetimes as "September 12 2026, 3:42 PM".
// =============================================================================

// All near-real-time labels render in this zone.
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

// Extracts date parts ("September", "12", "2026") in the farm timezone.
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