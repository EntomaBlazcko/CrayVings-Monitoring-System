// =============================================================================
// FILE: src/hooks/useThresholdAlert.ts
// =============================================================================
// Monitors sensor readings and triggers alerts when values breach thresholds.
// Enforces a 60-second cooldown per sensor+threshold to prevent spam.
// =============================================================================

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useSensorData, useSensorSettings } from "../contexts/SensorContext";
import { useFloatingAlerts } from "../hooks/useFloatingAlerts";
import { getSettingsThresholds, getThresholdStatus, type ThresholdStatus } from "../types";

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

  const thresholds = useMemo(
    () => settings ? getSettingsThresholds(settings) : null,
    [settings]
  );

  const checkThresholds = useCallback(() => {
    if (loading || !data || !thresholds) {
      return;
    }

    const now = Date.now();

    for (const key of SENSOR_KEYS) {
      const value = toNumber(data[key] as string | number);
      if (isNaN(value)) continue;

      const config = thresholds[key];
      if (!config) continue;

      const newStatus = getThresholdStatus(value, config.range, config.isMinOnly);

      // Fire alert ONLY on transition into breached state to avoid duplicate
      // toasts on every poll or ESP32 reconnect while reading stays out of range.
      const prevStatus = previousStatusRef.current[key];
      previousStatusRef.current[key] = newStatus;

      if (newStatus === "good" || (prevStatus && prevStatus !== "good")) {
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
  }, [data, thresholds, loading, addNotification]);

  useEffect(() => {
    checkThresholds();
  }, [checkThresholds]);
}
