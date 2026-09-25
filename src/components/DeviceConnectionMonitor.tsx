// Headless watcher: turns per-tank online/offline transitions into floating
// alerts, sounds, and activity-log entries. Fleet-wide: it tracks EVERY
// tank's online flag from the /devices registry (DB last_seen based, refreshed
// every 5s), so a tank going offline is announced even when it isn't the
// selected one. First sight of a tank seeds quietly so transitions that
// happened while the page was closed are never announced.

import { useEffect, useRef } from "react";
import { useSensorData, useActivityLogger } from "../hooks/useSensors";
import { useFloatingAlerts } from "../hooks/useFloatingAlerts";
import { playCriticalSound } from "../utils/playAlertSound";

export function DeviceConnectionMonitor() {
  const { devices } = useSensorData();
  const { addNotification, removeNotification } = useFloatingAlerts();
  const logActivity = useActivityLogger();

  const prevOnlineRef = useRef<Map<string, boolean>>(new Map());
  const disconnectAlertIdsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const seenIds = new Set<string>();

    for (const device of devices) {
      seenIds.add(device.device_id);
      const id = device.device_id;
      const label = device.tank_name || device.name || id;

      const prev = prevOnlineRef.current.get(id);
      if (device.online === prev) continue;

      // First sight of this tank: record its state without announcing.
      if (prev === undefined) {
        prevOnlineRef.current.set(id, device.online);
        continue;
      }
      prevOnlineRef.current.set(id, device.online);

      if (!device.online) {
        const notifId = `device-disconnect-${id}-${Date.now()}`;
        disconnectAlertIdsRef.current.set(id, notifId);

        addNotification({
          message: `${label} went offline — no data received from this tank`,
          type: "critical",
          parameter: "device",
          value: 0,
          threshold: "min",
          deviceId: id,
          tank: label,
        });

        logActivity(
          "device_disconnect",
          `${label} (${id}) went offline — no recent readings received`,
          "Sensors"
        );

        playCriticalSound();
      } else {
        const notifId = disconnectAlertIdsRef.current.get(id);
        if (notifId) {
          removeNotification(notifId);
          disconnectAlertIdsRef.current.delete(id);
        }

        logActivity(
          "device_connect",
          `${label} (${id}) is back online and sending data`,
          "Sensors"
        );

        addNotification({
          message: `${label} reconnected — data restored`,
          type: "warning",
          parameter: "device",
          value: 1,
          threshold: "min",
          deviceId: id,
          tank: label,
        });
      }
    }

    // Tanks that vanished from the registry (hidden/unregistered) drop
    // their seeded state so a later re-appearance re-seeds quietly.
    for (const id of prevOnlineRef.current.keys()) {
      if (!seenIds.has(id)) {
        prevOnlineRef.current.delete(id);
        disconnectAlertIdsRef.current.delete(id);
      }
    }
  }, [devices, addNotification, logActivity, removeNotification]);

  return null;
}
