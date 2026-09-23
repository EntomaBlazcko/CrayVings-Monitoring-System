// Freshest per-tank readings + threshold ranges for the Live Tank Bar and the
// Dashboard farm grid. Polls GET /devices/latest (in-memory on the server, so
// it is cheap) every 5s, paused while the tab is hidden.

import { useEffect, useState } from "react";
import { fetchDevicesLatest, fetchSettings } from "../api/client";
import { getSettingsThresholds, type DeviceLiveReading, type SensorThreshold } from "../types";

export function useDevicesLatest(pollIntervalMs = 5000) {
  const [latestByTank, setLatestByTank] = useState<Record<string, DeviceLiveReading>>({});
  const [thresholds, setThresholds] = useState<Record<string, SensorThreshold>>(getSettingsThresholds(null));

  useEffect(() => {
    let cancelled = false;

    const fetchLive = async () => {
      if (cancelled || document.hidden) return;
      try {
        const readings = await fetchDevicesLatest();
        if (cancelled) return;
        const readingsMap: Record<string, DeviceLiveReading> = {};
        for (const r of readings) {
          readingsMap[r.device_id] = r;
        }
        setLatestByTank(readingsMap);
      } catch {
        // Transient failure — keep the last readings; the next tick retries.
      }
    };

    fetchLive();
    const interval = setInterval(fetchLive, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((settings) => {
        if (!cancelled) setThresholds(getSettingsThresholds(settings));
      })
      .catch(() => {
        // Falls back to DEFAULT_SETTINGS-based thresholds.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { latestByTank, thresholds };
}
