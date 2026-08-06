// =============================================================================
// FILE: src/hooks/useThresholdAlert.ts
// =============================================================================
// PURPOSE: Hook that monitors sensor readings and triggers floating alerts
//          when values go outside their configured thresholds.
//
// This hook:
//   1. Watches the latest sensor data from SensorContext
//   2. Compares each reading against its min/max threshold
//   3. When a threshold is breached, creates a floating toast notification
//   4. Plays the appropriate alert sound (via FloatingAlertProvider)
//   5. Enforces a 60-second cooldown per sensor+threshold to prevent spam
//
// TRIGGERED BY:
//   Called in App.tsx's DashboardLayout component, so it runs whenever
//   the user is on any dashboard page.
//
// COOLDOWN MECHANISM:
//   Each sensor+threshold combination (e.g., "temperature-min")
//   has its own cooldown timer.
//   - But not repeated alerts for the same condition within 60 seconds
// =============================================================================

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useSensorData, useSensorSettings } from "../contexts/SensorContext";
import { useFloatingAlerts } from "../hooks/useFloatingAlerts";
import { getSettingsThresholds, getThresholdStatus, type ThresholdStatus } from "../types";

// 60-second cooldown between alerts for the same sensor+threshold
const ALERT_COOLDOWN_MS = 60000;
// Sensor keys to monitor (must match the keys in getSettingsThresholds)
const SENSOR_KEYS = ["temperature", "water_level", "ammonia"] as const;

/**
 * Safely converts a value to a number.
 * Handles strings, numbers, and undefined cases.
 */
function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseFloat(value);
  return 0;
}

/**
 * Hook that monitors sensor data and triggers floating alert notifications
 * when readings exceed configured thresholds.
 *
 * How it works:
 *   1. Gets latest sensor data and settings from context
 *   2. For each sensor, evaluates its value against min/max thresholds
 *   3. If outside range and cooldown has passed, adds a floating notification
 *   4. Notifications auto-play sounds and display in the top-right corner
 */
export function useThresholdAlert() {
  const { data, loading } = useSensorData();
  const { settings } = useSensorSettings();
  const { addNotification } = useFloatingAlerts();
  
  // Track last alert time per sensor+threshold to enforce cooldown
  const lastAlertTimeRef = useRef<Record<string, number>>({});
  // Track previous status for each sensor
  const previousStatusRef = useRef<Record<string, ThresholdStatus>>({});

  // Build threshold configuration from settings (memoized to avoid recalculation)
  const thresholds = useMemo(
    () => settings ? getSettingsThresholds(settings) : null,
    [settings]
  );

  /**
   * Checks all sensor readings against their thresholds.
   * Creates floating notifications for any readings outside the safe range,
   * respecting the cooldown period to prevent alert spam.
   */
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

      // Evaluate current status against thresholds
      const newStatus = getThresholdStatus(value, config.range, config.isMinOnly);
       
      // Update previous status tracker
      previousStatusRef.current[key] = newStatus;
      
      // Skip if the reading is within the safe range
      if (newStatus === "good") {
        continue;
      }
      
      // Determine which threshold was breached (min or max)
      const isBelowMin = value < config.range.min;
      const thresholdType = isBelowMin ? "min" : "max";
      const alertKey = `${key}-${thresholdType}`;
      
      // Check cooldown period
      const lastAlertTime = lastAlertTimeRef.current[alertKey] || 0;
      const timeSinceLastAlert = now - lastAlertTime;
      
      // Only send alert if cooldown has elapsed
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

  // Run threshold check whenever sensor data changes
  useEffect(() => {
    checkThresholds();
  }, [checkThresholds]);
}
