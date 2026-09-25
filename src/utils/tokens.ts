// Design tokens that cannot live in CSS alone.
//
// `src/index.css` @theme owns everything the DOM can express as a utility
// class. These are the values that have to exist as JavaScript strings because
// they are handed to APIs that never touch the cascade:
//
//   - recharts props (stroke / fill / tick fill) which become SVG attributes
//   - jsPDF, which needs numeric RGB triplets and cannot resolve var()
//
// The two lists intentionally overlap in places (see SENSOR_COLORS.ammonia and
// BAND_COLORS.safe). That is a known wart, not an accident: both are #10b981
// today, and separating them is a visual design call rather than a refactor.

// Per-sensor identity color. Deliberately NOT the brand ramp -- a sensor's
// meaning must stay stable even if the brand orange is rebranded.
export const SENSOR_COLORS = {
  temperature: "#f97316",
  water_level: "#2563eb",
  ammonia: "#10b981",
} as const;

// Recharts chrome: gridlines, axis lines, tick labels, fallback dots.
export const CHART_COLORS = {
  grid: "#f0f0f0",
  axis: "#e5e7eb",
  tick: "#9ca3af",
  muted: "#6b7280",
  dotFallback: "#64748b",
  overlay: "#94a3b8",
} as const;

// Safe-range and breach bands drawn behind chart series.
export const BAND_COLORS = {
  safe: "#10b981",
  breach: "#ef4444",
} as const;

// Fills for the paired readings/alerts bars.
export const BAR_COLORS = {
  readings: "#93c5fd",
  alerts: "#fca5a5",
} as const;

// jsPDF palette. Convert to triplets with hexToRgb() before passing to jsPDF.
export const PDF_COLORS = {
  ink: "#1e293b",
  gray: "#6b7280",
  white: "#ffffff",
  brand: "#d94b1e",
  amber: "#f59e0b",
  critical: "#d9441e",
  cardFill: "#fffaf5",
  cardLine: "#fde6d2",
  zebra: "#fff9f3",
  line: "#e2e8f0",
  onBrand: "#ffe7d5",
  tableHead: "#f1f5f9",
  tableZebra: "#f8fafc",
  tableMuted: "#808080",
  noteFill: "#fff7ed",
  noteLine: "#fed7aa",
  alertFill: "#fff4e6",
  alertFillOk: "#f0fdf4",
  alertLine: "#fdba74",
  alertLineOk: "#a7f3d0",
} as const;

// The report header gradient. Its endpoints sit between brand-500 and
// orange-500 rather than on the ramp, so they are declared explicitly instead
// of being snapped to a ramp step.
export const BRAND_GRADIENT = {
  from: "#c43211",
  to: "#ea580c",
  solid: "#c73e19",
} as const;

export type Rgb = [number, number, number];

// Accepts "#rgb" and "#rrggbb" (with or without the leading #).
export function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`hexToRgb: expected #rgb or #rrggbb, got ${JSON.stringify(hex)}`);
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
