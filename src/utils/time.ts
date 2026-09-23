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
