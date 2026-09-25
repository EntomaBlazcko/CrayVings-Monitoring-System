// Fleet-wide floating-alert watcher. Polls the freshest reading per tank
// (latestByTank, fed by the provider's 5s /devices/latest poll) and fires a
// tank-badged notification whenever ANY tank crosses into a breached state —
// previously only the selected tank was watched, so a critical breach in
// another tank was silent. Alerts only on transitions (a value that stays bad
// is not re-announced) and enforces a 60s cooldown per tank+sensor+threshold.
// Each tank is evaluated against its own EFFECTIVE thresholds (global defaults
// + per-tank overrides), and an edit to either re-seeds silently.

import { useEffect, useRef } from "react";
import { useSensorData, useSensorSettings } from "./useSensors";
import { useFloatingAlerts } from "./useFloatingAlerts";
import { getThresholdStatus, type SensorThreshold, type ThresholdStatus } from "../types";

const ALERT_COOLDOWN_MS = 60000;
const SENSOR_KEYS = ["temperature", "water_level", "ammonia"] as const;

// Null (failed sensor) is not a reading — return NaN so the caller skips it
// instead of treating it as 0, which would raise a false "Low" alert.
function toNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseFloat(value);
  return Number.NaN;
}

export function useThresholdAlert() {
  const { latestByTank, devices } = useSensorData();
  const { thresholdsFor, settingsFor } = useSensorSettings();
  const { addNotification } = useFloatingAlerts();

  const lastAlertTimeRef = useRef<Record<string, number>>({});
  const previousStatusRef = useRef<Record<string, ThresholdStatus>>({});
  // The threshold map each tank's previous-status was seeded against. A change
  // here means the user edited settings (global or that tank's override), not
  // that a sensor crossed anything — re-seed silently.
  const seededThresholdsRef = useRef<Map<string, Record<string, SensorThreshold>>>(new Map());

  useEffect(() => {
    const now = Date.now();
    const labelFor = (deviceId: string) => {
      const device = devices.find((d) => d.device_id === deviceId);
      return device?.tank_name || device?.name || deviceId;
    };

    for (const [deviceId, reading] of Object.entries(latestByTank)) {
      const thresholds = thresholdsFor(deviceId);

      // First sight of a tank (or a threshold edit): seed the previous-status
      // map without announcing, so pre-existing breaches and settings edits are
      // never reported as fresh crossings.
      if (seededThresholdsRef.current.get(deviceId) !== thresholds) {
        seededThresholdsRef.current.set(deviceId, thresholds);
        for (const key of SENSOR_KEYS) {
          const config = thresholds[key];
          const value = toNumber(reading[key]);
          if (config && !Number.isNaN(value)) {
            previousStatusRef.current[`${deviceId}:${key}`] = getThresholdStatus(value, config.range, config.isMinOnly);
          }
        }
        continue;
      }

      for (const key of SENSOR_KEYS) {
        const value = toNumber(reading[key]);
        if (Number.isNaN(value)) continue;

        const config = thresholds[key];
        if (!config) continue;

        const newStatus = getThresholdStatus(value, config.range, config.isMinOnly);

        // Alert ONLY on a live transition into a breached state: a missing
        // previous status (first evaluation) or an already-breached status
        // means nothing just crossed.
        const statusKey = `${deviceId}:${key}`;
        const prevStatus = previousStatusRef.current[statusKey];
        previousStatusRef.current[statusKey] = newStatus;

        if (newStatus === "good") continue;
        if (prevStatus !== "good") continue;

        const isBelowMin = value < config.range.min;
        const thresholdType = isBelowMin ? "min" : "max";
        const alertKey = `${deviceId}-${key}-${thresholdType}`;

        if (now - (lastAlertTimeRef.current[alertKey] || 0) > ALERT_COOLDOWN_MS) {
          const label = labelFor(deviceId);
          const prefix = isBelowMin ? "Low" : "High";
          const message = `${prefix} ${config.name}: ${value}${config.unit} is ${isBelowMin ? "below" : "above"} threshold (${config.range.min}${config.unit} - ${config.range.max}${config.unit})`;

          lastAlertTimeRef.current[alertKey] = now;

          addNotification({
            message,
            type: newStatus === "critical" ? "critical" : "warning",
            parameter: key,
            value,
            threshold: thresholdType,
            deviceId,
            tank: label,
            // The tank's effective settings ride along so the "Fix?" modal
            // shows the right safe range for THIS tank.
            settings: settingsFor(deviceId),
          });
        }
      }
    }
  }, [latestByTank, thresholdsFor, settingsFor, devices, addNotification]);
}
