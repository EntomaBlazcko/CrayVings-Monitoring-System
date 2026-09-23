// =============================================================================
// FILE: src/hooks/useDevicesLatest.ts
// PURPOSE: Shared live-readings hook for the multi-tank UI. Polls GET
// /devices/latest (the server's in-memory freshest reading per tank) every 5s
// - paused when the tab is hidden - and loads the saved threshold ranges once,
// so tank cards can red-flag out-of-range values consistently. Replaces the
// deleted useTankLive (which duplicated 1s polling).
// =============================================================================

import { useEffect, useState } from "react";
import { fetchDevicesLatest, fetchSettings } from "../api/client";
import { getSettingsThresholds, type DeviceLiveReading, type SensorThreshold } from "../types";

export function useDevicesLatest(pollIntervalMs = 5000) {
  const [latestByTank, setLatestByTank] = useState<Record<string, DeviceLiveReading>>({});
  const [thresholds, setThresholds] = useState<Record<string, SensorThreshold>>(getSettingsThresholds(null));

  // Poll for live readings for all tanks (aligned with the devices poll).
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
        // transient - keep whatever we have; next tick retries
      }
    };

    fetchLive();
    const interval = setInterval(fetchLive, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  // Load saved threshold ranges once.
  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((settings) => {
        if (!cancelled) setThresholds(getSettingsThresholds(settings));
      })
      .catch(() => {
        // fall back to DEFAULT_SETTINGS-based thresholds
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { latestByTank, thresholds };
}