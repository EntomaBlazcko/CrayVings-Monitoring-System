// Watches live readings and fires a floating notification when a value crosses
// into a breached state. Alerts only on transitions (a value that stays bad is
// not re-announced) and enforces a 60s cooldown per sensor+threshold.

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useSensorData, useSensorSettings } from "./useSensors";
import { useFloatingAlerts } from "./useFloatingAlerts";
import { getSettingsThresholds, getThresholdStatus, type ThresholdRange, type ThresholdStatus } from "../types";

const ALERT_COOLDOWN_MS = 60000;
const SENSOR_KEYS = ["temperature", "water_level", "ammonia"] as const;

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseFloat(value);
  return 0;
}

export function useThresholdAlert() {
  const { latestReading, loading } = useSensorData();
  const { settings } = useSensorSettings();
  const { addNotification } = useFloatingAlerts();

  const lastAlertTimeRef = useRef<Record<string, number>>({});
  const previousStatusRef = useRef<Record<string, ThresholdStatus>>({});
  // Thresholds the previous-status map was seeded against. A change here means
  // the user edited settings, not that a sensor crossed anything.
  const thresholdsRef = useRef<Record<string, { range: ThresholdRange; isMinOnly: boolean }> | null>(null);

  const thresholds = useMemo(
    () => settings ? getSettingsThresholds(settings) : null,
    [settings]
  );

  // Re-seeds the previous-status map. Runs only on the first evaluation and
  // whenever threshold settings change, so pre-existing out-of-range readings
  // (and settings edits) are never announced as a fresh crossing.
  const seedStatuses = useCallback(() => {
    if (!latestReading || !thresholds) return;
    for (const key of SENSOR_KEYS) {
      const config = thresholds[key];
      const value = toNumber(latestReading[key] as string | number);
      if (config && !isNaN(value)) {
        previousStatusRef.current[key] = getThresholdStatus(value, config.range, config.isMinOnly);
      }
    }
    thresholdsRef.current = thresholds;
  }, [latestReading, thresholds]);

  const checkThresholds = useCallback(() => {
    if (loading || !latestReading || !thresholds) {
      return;
    }

    if (thresholdsRef.current !== thresholds) {
      seedStatuses();
    }

    const now = Date.now();

    for (const key of SENSOR_KEYS) {
      const value = toNumber(latestReading[key] as string | number);
      if (isNaN(value)) continue;

      const config = thresholds[key];
      if (!config) continue;

      const newStatus = getThresholdStatus(value, config.range, config.isMinOnly);

      // Alert ONLY on a live transition into a breached state: a missing
      // previous status (first evaluation) or an already-breached status means
      // nothing just crossed.
      const prevStatus = previousStatusRef.current[key];
      previousStatusRef.current[key] = newStatus;

      if (newStatus === "good") continue;
      if (prevStatus !== "good") continue;

      const isBelowMin = value < config.range.min;
      const thresholdType = isBelowMin ? "min" : "max";
      const alertKey = `${key}-${thresholdType}`;

      if (now - (lastAlertTimeRef.current[alertKey] || 0) > ALERT_COOLDOWN_MS) {
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
  }, [latestReading, thresholds, loading, addNotification, seedStatuses]);

  useEffect(() => {
    checkThresholds();
  }, [checkThresholds]);
}
