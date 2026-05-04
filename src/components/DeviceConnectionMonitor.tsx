// =============================================================================
// FILE: src/components/DeviceConnectionMonitor.tsx
// =============================================================================
// PURPOSE: Invisible component that monitors ESP32 connection status changes
//          and triggers alerts, notifications, and SMS when the device disconnects.
//
// This component has NO visible UI (returns null). It works as a background
// watcher that:
//   1. Watches the connectionStatus from the sensor data context
//   2. Detects transitions to "offline" (includes sensorData === null path)
//   3. Detects transitions from "offline" to "online" (reconnection)
//   4. On disconnect: plays critical sound, adds floating notification,
//      logs the event, and triggers SMS alerts to all recipients
//   5. On reconnect: removes the disconnect notification, logs the event,
//      and shows a "reconnected" notification
//
// MOUNTED IN: App.tsx (always active, outside page routing)
// =============================================================================

import { useEffect, useRef } from "react";
import { useSensorData } from "../hooks/useSensors";
import { useFloatingAlerts } from "../hooks/useFloatingAlerts";
import { useActivityLogger } from "../hooks/useSensors";
import { playCriticalSound } from "../utils/playAlertSound";
import { sendDeviceDisconnectAlert } from "../api/client";

type ConnectionStatus = "online" | "offline" | "connecting" | "unknown";

/**
 * Background component that watches for ESP32 connection status changes.
 * Triggers alerts, notifications, and SMS when the device goes offline or reconnects.
 * Renders nothing (returns null) - it's a pure logic component.
 */
export function DeviceConnectionMonitor() {
  const { connectionStatus, consecutiveFailures, lastUpdate } = useSensorData();
  const { addNotification, removeNotification } = useFloatingAlerts();
  const logActivity = useActivityLogger();
  const prevStatusRef = useRef<ConnectionStatus>("connecting");
  const prevFailuresRef = useRef(0);
  const disconnectAlertIdRef = useRef<string | null>(null);
  const smsSentRef = useRef(false);

  // Monitor connection status changes
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const prevFailures = prevFailuresRef.current;
    prevStatusRef.current = connectionStatus;
    prevFailuresRef.current = consecutiveFailures;

    // Detect transition: any state -> offline (device disconnected)
    const wentOffline =
      connectionStatus === "offline" && prevStatus !== "offline";
    // Detect transition: offline -> online (device reconnected)
    // Also catch when consecutiveFailures drop to 0 (fresh data restored)
    const cameOnline =
      (connectionStatus === "online" && prevStatus === "offline") ||
      (consecutiveFailures === 0 && prevFailures > 0 && connectionStatus === "online");

    if (wentOffline) {
      // Reset SMS sent flag for this disconnect event
      smsSentRef.current = false;
      const id = `device-disconnect-${Date.now()}`;
      disconnectAlertIdRef.current = id;

      // Show floating notification
      addNotification({
        message: "ESP32 device disconnected — no data received",
        type: "critical",
        parameter: "device",
        value: 0,
        threshold: "min",
      });

      // Log the disconnect event for activity tracking
      logActivity(
        "device_disconnect",
        `ESP32 device went offline after ${consecutiveFailures} failed polls`,
        "Sensors"
      );

      // Trigger SMS alerts to all active recipients (handled by backend)
      sendDeviceDisconnectAlert(
        `ESP32 device disconnected — no data for 15+ seconds`,
        consecutiveFailures
      );

      // Play critical alert sound
      playCriticalSound();
    }

    if (cameOnline) {
      // Remove the disconnect notification when device reconnects
      if (disconnectAlertIdRef.current) {
        removeNotification(disconnectAlertIdRef.current);
        disconnectAlertIdRef.current = null;
      }

      // Log the reconnection event
      logActivity(
        "device_connect",
        "ESP32 device reconnected and sending data",
        "Sensors"
      );

      // Show reconnection notification
      addNotification({
        message: "ESP32 device reconnected — data restored",
        type: "warning",
        parameter: "device",
        value: 1,
        threshold: "min",
      });
    }
  }, [connectionStatus, consecutiveFailures, lastUpdate, addNotification, logActivity, removeNotification]);

  // This component renders nothing - it's a background watcher
  return null;
}
