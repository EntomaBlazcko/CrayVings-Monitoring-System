// =============================================================================
// FILE: src/hooks/useThresholdAlert.ts
// =============================================================================
// Monitors sensor readings and triggers alerts when values breach thresholds.
// Enforces a 60-second cooldown per sensor+threshold to prevent spam.
// =============================================================================

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useSensorData, useSensorSettings } from "../contexts/SensorContext";
import { useFloatingAlerts } from "../hooks/useFloatingAlerts";
import { getSettingsThresholds, getThresholdStatus, type ThresholdRange, type ThresholdStatus } from "../types";

// 60-second cooldown between alerts for the same sensor+threshold
const ALERT_COOLDOWN_MS = 60000;
const SENSOR_KEYS = ["temperature", "water_level", "ammonia"] as const;

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseFloat(value);
  return 0;
}

// Monitors sensor data and fires floating notifications when thresholds are breached.
export function useThresholdAlert() {
  const { data, loading } = useSensorData();
  const { settings } = useSensorSettings();
  const { addNotification } = useFloatingAlerts();

  const lastAlertTimeRef = useRef<Record<string, number>>({});
  const previousStatusRef = useRef<Record<string, ThresholdStatus>>({});
  // Thresholds used for the current previous-status map. A change here means the
  // user edited settings, not that the sensor crossed anything — see below.
  const thresholdsRef = useRef<Record<string, { range: ThresholdRange; isMinOnly: boolean }> | null>(null);

  const thresholds = useMemo(
    () => settings ? getSettingsThresholds(settings) : null,
    [settings]
  );

  // Re-seeds the previous-status map for the current thresholds. Runs only on the
  // first evaluation and whenever threshold settings change, so pre-existing
  // out-of-range readings (and settings edits) are never announced as a crossing.
  const seedStatuses = useCallback(() => {
    if (!data || !thresholds) return;
    for (const key of SENSOR_KEYS) {
      const config = thresholds[key];
      const value = toNumber(data[key] as string | number);
      if (config && !isNaN(value)) {
        previousStatusRef.current[key] = getThresholdStatus(value, config.range, config.isMinOnly);
      }
    }
    thresholdsRef.current = thresholds;
  }, [data, thresholds]);

  const checkThresholds = useCallback(() => {
    if (loading || !data || !thresholds) {
      return;
    }

    // If thresholds changed since the last check (e.g. a settings save), refresh
    // the baseline statuses before evaluating so an edit never fires a fake alert.
    if (thresholdsRef.current !== thresholds) {
      seedStatuses();
    }

    const now = Date.now();

    for (const key of SENSOR_KEYS) {
      const value = toNumber(data[key] as string | number);
      if (isNaN(value)) continue;

      const config = thresholds[key];
      if (!config) continue;

      const newStatus = getThresholdStatus(value, config.range, config.isMinOnly);

      // Fire alert ONLY on a live transition INTO a breached state. A missing
      // previous status (first evaluation) or an already-breached status means
      // the reading did not just cross a threshold, so we stay silent.
      const prevStatus = previousStatusRef.current[key];
      previousStatusRef.current[key] = newStatus;

      if (newStatus === "good") {
        continue;
      }
      if (prevStatus !== "good") {
        continue;
      }

      const isBelowMin = value < config.range.min;
      const thresholdType = isBelowMin ? "min" : "max";
      const alertKey = `${key}-${thresholdType}`;

      const lastAlertTime = lastAlertTimeRef.current[alertKey] || 0;
      const timeSinceLastAlert = now - lastAlertTime;

      if (timeSinceLastAlert > ALERT_COOLDOWN_MS) {
        const prefix = isBelowMin ? "Low" : "High";
        const message = `${prefix} ${config.name}: ${value}${config.unit} is ${isBelowMin ? "below" : "above"} threshold (${config.range.min}${config.unit} - ${config.range.max}${config.unit})`;

        lastAlertTimeRef.current[alertKey] = now;

        addNotification({
          message,
          type: newStatus === "critical" ? "critical" : "warning",
          parameter: key,
          value,
          threshold: thresholdType,
        });
      }
    }
  }, [data, thresholds, loading, addNotification, seedStatuses]);

  useEffect(() => {
    checkThresholds();
  }, [checkThresholds]);
}
