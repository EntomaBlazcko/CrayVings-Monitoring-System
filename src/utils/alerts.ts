import type { SensorEntry } from "../types";

export function getAlerts(data: SensorEntry | null): string[] {
  if (!data) return ["No live sensor data available"];

  const alerts: string[] = [];

  if (data.temperature > 31) alerts.push("High temperature detected");
  if (data.temperature < 20) alerts.push("Low temperature detected");
  if (data.ph < 6.5 || data.ph > 8.5) alerts.push("pH level is outside safe range");
  if (data.dissolved_oxygen < 5) alerts.push("Low dissolved oxygen detected");
  if (data.ammonia > 0.5) alerts.push("High ammonia detected");
  if (data.water_level < 5) alerts.push("Low water level detected");

  return alerts.length ? alerts : ["Tank is Safe"];
}
