import { useEffect, useRef } from "react";
import { useSensorData, useSensorSettings } from "../contexts/SensorContext";
import { useFloatingAlerts } from "../components/FloatingAlert";
import { getSettingsThresholds, getThresholdStatus } from "../types";

export function useThresholdAlert() {
  const { data, loading } = useSensorData();
  const { settings } = useSensorSettings();
  const { addNotification } = useFloatingAlerts();
  const previousAlertsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loading || !data || !settings) {
      return;
    }

    const thresholds = getSettingsThresholds(settings);
    const currentAlerts = new Set<string>();

    const sensorKeys: (keyof typeof data)[] = [
      "temperature",
      "water_level",
      "ph",
      "dissolved_oxygen",
      "ammonia",
    ];

    for (const key of sensorKeys) {
      const value = data[key];
      if (typeof value !== "number") continue;

      const config = thresholds[key];
      if (!config) continue;

      const status = getThresholdStatus(value, config.range, config.isMinOnly);

      if (status !== "good") {
        const isBelowMin = value < config.range.min;
        const thresholdType = isBelowMin ? "min" : "max";

        const alertKey = `${key}-${thresholdType}`;
        currentAlerts.add(alertKey);

        if (!previousAlertsRef.current.has(alertKey)) {
          const prefix = isBelowMin ? "Low" : "High";
          const message = `${prefix} ${config.name}: ${value}${config.unit} is ${isBelowMin ? "below" : "above"} threshold (${config.range.min}${config.unit} - ${config.range.max}${config.unit})`;

          addNotification({
            message,
            type: status === "critical" ? "critical" : "warning",
            parameter: key,
            value,
            threshold: thresholdType,
          });
        }
      }
    }

    previousAlertsRef.current = currentAlerts;
  }, [data, settings, loading, addNotification]);
}