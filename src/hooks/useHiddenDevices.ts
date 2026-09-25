// Shared hidden-tanks panel logic (restore flow). Both TankSelector and
// FarmOverview render a hidden-tanks section; this hook owns the identical
// fetch/show/restore logic so it lives in exactly one place. Hiding is never
// destructive — PUT /devices/:id { is_active: false } keeps all data and the
// restore panel (include_hidden=1) brings the tank back.

import { useState } from "react";
import { fetchDevices, updateDevice } from "../api/client";
import type { DeviceEntry } from "../types";

export function useHiddenDevices(refetchFleet: () => void) {
  const [showHidden, setShowHidden] = useState(false);
  const [hiddenDevices, setHiddenDevices] = useState<DeviceEntry[] | null>(null);
  const [loadingHidden, setLoadingHidden] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const toggleHiddenPanel = async () => {
    if (showHidden) {
      setShowHidden(false);
      return;
    }
    setShowHidden(true);
    setLoadingHidden(true);
    try {
      const all = await fetchDevices(true);
      setHiddenDevices(all.filter((d) => !d.is_active));
    } catch {
      setHiddenDevices([]);
    } finally {
      setLoadingHidden(false);
    }
  };

  const restore = async (deviceId: string) => {
    setRestoring(deviceId);
    try {
      await updateDevice(deviceId, { is_active: true });
      setHiddenDevices((prev) => (prev ?? []).filter((d) => d.device_id !== deviceId));
      await refetchFleet();
    } catch {
      // keep the chip in place; user can retry
    } finally {
      setRestoring(null);
    }
  };

  return {
    showHidden,
    hiddenDevices,
    hiddenCount: hiddenDevices?.length ?? 0,
    loadingHidden,
    restoring,
    toggleHiddenPanel,
    restore,
  };
}
