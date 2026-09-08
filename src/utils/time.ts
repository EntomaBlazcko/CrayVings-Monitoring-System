// =============================================================================
// FILE: src/utils/time.ts
// =============================================================================
// PURPOSE: Centralized time formatting helpers that render timestamps in the
//          farm's canonical timezone (Asia/Manila).
//
// WHY THIS EXISTS:
//   Sensor timestamps are stored by the server as UTC (JS Date). Rendering them
//   with the browser's local `toLocaleTimeString()` produces different times for
//   viewers in different timezones — and can be wrong for everyone if the server
//   clock differs from the farm clock. These helpers make every near-real-time
//   label show the same canonical farm time regardless of where you view from.
//
// USAGE:
//   import { formatFarmTime, formatFarmDate } from "../utils/time";
//   formatFarmTime(new Date(latest.timestamp)) // "3:42 PM"
// =============================================================================

/** The farm's canonical timezone. All near-real-time labels render in this zone. */
export const FARM_TIME_ZONE = "Asia/Manila";

/**
 * Formats a Date in the farm timezone as a short time (e.g. "3:42 PM").
 * Falls back to the browser-local rendering if the value is invalid.
 */
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

/**
 * Formats a Date in the farm timezone as a full date + time (e.g. "9/8/2026, 3:42 PM").
 * Falls back to the browser-local rendering if the value is invalid.
 */
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