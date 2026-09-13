// =============================================================================
// src/utils/alertGuidance.ts
// The "Fix Legend" for sensor alerts. Single source of truth for the suggested
// fixes shown on the Alerts page (legend panel + per-alert modal).
// =============================================================================

import {
  getSettingsThresholds,
  getThresholdStatus,
  parseAlertSeverity,
  DISPLAY_TO_SENSOR_KEY,
  type AlertSeverity,
  type LogEntry,
  type SensorSettings,
  type ThresholdRange,
} from "../types";

// One pre-written "scenario" in the legend: a sensor parameter + direction and
// the guidance attached to it. Safe-range comes from live settings at render
// time (see getAlertGuidance) so it is never hard-coded here.
export type AlertFixScenario = {
  parameterKey: string;
  name: string;
  unit: string;
  direction: "High" | "Low";
  diagnosis: string;
  fixes: string[];
  preventionTip?: string;
};

// Full guidance for a single alert log, merging live settings + severity.
export type AlertGuidance = AlertFixScenario & {
  currentValue: number | null;
  severity: AlertSeverity;
  safeRange: ThresholdRange;
};

// Ordered legend covering every alert scenario the server can emit.
export const ALERT_FIX_LEGEND: Record<string, AlertFixScenario> = {
  "temperature:High": {
    parameterKey: "temperature",
    name: "Temperature",
    unit: "°C",
    direction: "High",
    diagnosis: "Water temperature is above the safe upper limit. Elevated heat stresses the crayfish and lowers dissolved oxygen.",
    fixes: [
      "Increase aeration / circulation to help the water cool and add oxygen",
      "Add cooler water following the farm's water-change procedure",
      "Provide shade or reduce direct sunlight over the tank on hot days",
      "Check the heater/thermostat is not stuck ON and confirm the reading with a second thermometer",
    ],
    preventionTip: "Keep the tank out of direct heat and monitor during peak afternoon hours.",
  },
  "temperature:Low": {
    parameterKey: "temperature",
    name: "Temperature",
    unit: "°C",
    direction: "Low",
    diagnosis: "Water temperature is below the safe lower limit. Cold water slows metabolism and feeding.",
    fixes: [
      "Turn on the heater and set it inside the safe range",
      "Insulate the tank or block cold drafts around the tank area",
      "Check the heater/thermostat for faults and verify the reading with a second thermometer",
    ],
    preventionTip: "Schedule a heater check before colder periods.",
  },
  "water_level:High": {
    parameterKey: "water_level",
    name: "Water Level",
    unit: "%",
    direction: "High",
    diagnosis: "Water level is above the safe upper limit. Overflow can damage equipment and risk losing stock.",
    fixes: [
      "Drain / dump water until the level is back inside the safe range",
      "Throttle or close the inlet valve to stop incoming water",
      "Check the overflow / drain line for blockages",
    ],
    preventionTip: "Balance inlet and outlet flow so the tank regulates itself.",
  },
  "water_level:Low": {
    parameterKey: "water_level",
    name: "Water Level",
    unit: "%",
    direction: "Low",
    diagnosis: "Water level is below the safe lower limit. Low water exposes pumps and stresses the stock.",
    fixes: [
      "Top up water to bring the level back into the safe range",
      "Inspect for leaks or excess evaporation and seal them",
      "Check the pump and inlet line for blockages or air locks",
    ],
    preventionTip: "Schedule regular top-ups and check the pump inlet weekly.",
  },
  "ammonia:High": {
    parameterKey: "ammonia",
    name: "Ammonia",
    unit: "ppm",
    direction: "High",
    diagnosis: "Ammonia is above the safe upper limit. Raised ammonia is toxic to crayfish and usually means excess waste or overfeeding.",
    fixes: [
      "Perform a partial water change (25–50%) to dilute the ammonia",
      "Hold or reduce feeding until ammonia drops back into the safe range",
      "Add or improve bio-filtration / beneficial bacteria to speed up the nitrogen cycle",
      "Remove uneaten food, dead matter, and waste from the tank",
      "Increase aeration to support the nitrogen cycle",
    ],
    preventionTip: "Track feeding closely and re-test ammonia after filter or aeration changes.",
  },
  "ammonia:Low": {
    parameterKey: "ammonia",
    name: "Ammonia",
    unit: "ppm",
    direction: "Low",
    diagnosis: "Ammonia is below the configured threshold. This is typically safe and often indicates a healthy, cycled tank.",
    fixes: [
      "No action required — low ammonia is normal and safe",
      "Re-check the configured ammonia minimum if this alert seems unexpected",
    ],
    preventionTip: "Continue normal monitoring; low ammonia is a good sign.",
  },
};

// Ordered legend keys for a stable panel listing (Dashboard / Sensors / Alerts).
export const ALERT_SCENARIO_KEYS = [
  "temperature:High",
  "temperature:Low",
  "water_level:High",
  "water_level:Low",
  "ammonia:High",
  "ammonia:Low",
] as const;

// Builds guidance for a scenario key ("temperature:High") with an optional live
// reading. Falls back to safe warning severity when no live value is provided.
export function buildScenarioGuidance(
  scenarioKey: string,
  settings?: SensorSettings | null,
  value?: number | null
): AlertGuidance | null {
  const scenario = ALERT_FIX_LEGEND[scenarioKey];
  if (!scenario) return null;
  const config = getSettingsThresholds(settings ?? null)[scenario.parameterKey];
  const safeRange: ThresholdRange = config?.range ?? { min: 0, max: 0 };
  const currentValue = value != null && Number.isFinite(value) ? value : null;
  let severity: AlertSeverity = "warning";
  if (currentValue != null && config) {
    severity = getThresholdStatus(currentValue, config.range, config.isMinOnly) === "critical" ? "critical" : "warning";
  }
  return { ...scenario, currentValue, severity, safeRange };
}

// Builds guidance directly from a live sensor value (no stored log required).
// Returns null for in-range readings, unknown parameters, or missing values.
export function buildLiveGuidance(
  parameterKey: string,
  value: number | null,
  settings?: SensorSettings | null
): AlertGuidance | null {
  if (value == null || !Number.isFinite(value)) return null;
  const config = getSettingsThresholds(settings ?? null)[parameterKey];
  if (!config) return null;
  const status = getThresholdStatus(value, config.range, config.isMinOnly);
  if (status === "good") return null;
  const direction: "High" | "Low" = value < config.range.min ? "Low" : "High";
  return buildScenarioGuidance(`${parameterKey}:${direction}`, settings, value);
}

// Resolves the legend entry for a single alert log, enriched with the live
// safe range and severity. Returns null for Change / Alert Resolved / unknown.
export function getAlertGuidance(log: LogEntry, settings?: SensorSettings | null): AlertGuidance | null {
  if (log.action !== "Alert") return null;

  const parameterKey = DISPLAY_TO_SENSOR_KEY[log.parameter];
  if (!parameterKey) return null;

  const direction: "High" | "Low" = String(log.old_value ?? "") === "Low" ? "Low" : "High";
  const scenario = ALERT_FIX_LEGEND[`${parameterKey}:${direction}`];
  if (!scenario) return null;

  const config = getSettingsThresholds(settings ?? null)[parameterKey];
  const rawValue = Number(log.new_value);

  return {
    ...scenario,
    currentValue: Number.isFinite(rawValue) ? rawValue : null,
    severity: parseAlertSeverity(log, settings),
    safeRange: config?.range ?? { min: 0, max: 0 },
  };
}