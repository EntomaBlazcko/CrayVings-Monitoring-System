// Title-cases a sensor key or log action, e.g. "water_level" -> "Water Level".
export const titleCase = (s: string) =>
  String(s)
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
