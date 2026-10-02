// Title-cases a sensor key or log action, e.g. "water_level" -> "Water Level".
export const titleCase = (s: string) =>
  String(s)
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

// Renders a report/analytics aggregate, showing "--" when there is no value.
//
// A failed sensor is stored as NULL, so a day or window with no valid readings
// has no average at all. The `?? 0` fallbacks this replaces printed that as
// "0.0 °C" - indistinguishable from a tank genuinely sitting at zero, and on an
// ammonia average it reads as perfectly safe. Every display of one of these
// numbers goes through here so "no data" looks the same on every page.
export function fmtStat(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return value.toFixed(digits);
}
