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

// Display precision per sensor, matching the card metadata already used by
// SensorsPage / TankSelector / FarmOverview / HistoricalDataPage: the live tiles
// on the dashboard used to interpolate the raw wire value (which arrives at a
// different precision than the DB's DECIMAL(5,2)), so the dashboard could show
// e.g. "0.412" while the sensors page showed "0.41". Routing every live render
// through fmtSensor below gives every surface the same precision.
export const SENSOR_DECIMALS = {
  temperature: 1,
  water_level: 0,
  ammonia: 2,
} as const;

export type SensorKey = keyof typeof SENSOR_DECIMALS;

// Renders a live sensor value at the shared display precision. "-" for a
// failed (null) or non-finite reading -- a failed sensor must never render as
// "0", which is a real, actionable reading. The caller appends its own unit.
export function fmtSensor(key: SensorKey, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return value.toFixed(SENSOR_DECIMALS[key]);
}

// Coerces one DECIMAL column (pg returns those as strings) into a number, and
// drops the ESP32 failed-sensor sentinels. `min` is the lowest value that counts
// as a real reading: pass 0.0001 for temperature (0 C is the wire sentinel),
// leave it alone for water_level/ammonia where 0 is a genuine, actionable value.
//
// null has to survive all the way to the chart: Recharts breaks the line on a
// null point, which is the honest rendering, whereas turning it into 0 drew a
// plunge to the floor for a window in which the sensor was simply dead.
//
// Why null is tested BEFORE Number() is called, rather than after: Number(null)
// is 0, so a guard that coerces first and validates second cannot tell a failed
// sensor from a tank sitting at zero. A dead probe then reaches the charts as a
// real 0 - dragging the Y-axis floor down and pulling min/avg/max toward it -
// and, because ammonia's floor is 0.25, renders as a red out-of-range reading
// instead of "--". Coercion has to be the first thing that happens, because that
// is the only step that can still tell null from 0.
export function toNum(v: unknown, min = -Infinity): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : null;
}
