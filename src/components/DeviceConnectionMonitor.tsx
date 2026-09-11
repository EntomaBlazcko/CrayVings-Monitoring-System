// =============================================================================
// FILE: src/components/DeviceConnectionMonitor.tsx
// PURPOSE: Background watcher for ESP32 connection status (no visible UI).
// =============================================================================

import { useEffect, useRef } from "react";
import { useSensorData } from "../hooks/useSensors";
import { useFloatingAlerts } from "../hooks/useFloatingAlerts";
import { useActivityLogger } from "../hooks/useSensors";
import { playCriticalSound } from "../utils/playAlertSound";

type ConnectionStatus = "online" | "offline" | "connecting" | "unknown";

// Watches ESP32 connection status; triggers alerts on disconnect/reconnect.
export function DeviceConnectionMonitor() {
  const { connectionStatus, consecutiveFailures, lastUpdate } = useSensorData();
  const { addNotification, removeNotification } = useFloatingAlerts();
  const logActivity = useActivityLogger();
  const prevStatusRef = useRef<ConnectionStatus>("connecting");
  const prevFailuresRef = useRef(0);
  const disconnectAlertIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const prevFailures = prevFailuresRef.current;
    prevStatusRef.current = connectionStatus;
    prevFailuresRef.current = consecutiveFailures;

    const wentOffline =
      connectionStatus === "offline" && prevStatus !== "offline";
    // Also catch when consecutiveFailures drop to 0 (fresh data restored)
    const cameOnline =
      (connectionStatus === "online" && prevStatus === "offline") ||
      (consecutiveFailures === 0 && prevFailures > 0 && connectionStatus === "online");

    if (wentOffline) {
      const id = `device-disconnect-${Date.now()}`;
      disconnectAlertIdRef.current = id;

      addNotification({
        message: "ESP32 device disconnected — no data received",
        type: "critical",
        parameter: "device",
        value: 0,
        threshold: "min",
      });

      logActivity(
        "device_disconnect",
        `ESP32 device went offline after ${consecutiveFailures} failed polls`,
        "Sensors"
      );

      playCriticalSound();
    }

    if (cameOnline) {
      if (disconnectAlertIdRef.current) {
        removeNotification(disconnectAlertIdRef.current);
        disconnectAlertIdRef.current = null;
      }

      logActivity(
        "device_connect",
        "ESP32 device reconnected and sending data",
        "Sensors"
      );

      addNotification({
        message: "ESP32 device reconnected — data restored",
        type: "warning",
        parameter: "device",
        value: 1,
        threshold: "min",
      });
    }
  }, [connectionStatus, consecutiveFailures, lastUpdate, addNotification, logActivity, removeNotification]);

  return null;
}
