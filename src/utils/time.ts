// =============================================================================
// FILE: src/utils/time.ts
// =============================================================================
// Time formatting helpers that render timestamps in the farm's timezone (Asia/Manila).
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

// Formats as full date+time (e.g. "9/8/2026, 3:42 PM"); returns "N/A" on invalid input.
export function formatFarmDateTime(value: Date | string | null | undefined): string {
  if (!value) return "N/A";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  try {
    return d.toLocaleString(undefined, { timeZone: FARM_TIME_ZONE });
  } catch {
    return d.toLocaleString();
  }
}
