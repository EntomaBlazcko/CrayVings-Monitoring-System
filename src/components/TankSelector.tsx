// "Live Tank Bar": fleet-wide tank switcher. Each card shows the tank name,
// online/offline state, and the freshest temp / water / ammonia values (red
// when out of range), plus rename / hide / live-diagnostics actions. Clicking
// a card selects that tank for Dashboard / Historical Data / Analytics.

import { useState, useCallback } from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { useSensorData } from "../hooks/useSensors";
import { useDevicesLatest } from "../hooks/useDevicesLatest";
import { fetchDevices, updateDevice } from "../api/client";
import type { DeviceEntry } from "../types";
import { DeviceHide, DeviceLiveCheck, DeviceRename } from "./deviceActions";

function deviceLabel(device: DeviceEntry): string {
  return device.tank_name || device.name || device.device_id;
}

export default function TankSelector() {
  const { devices, devicesLoading, selectedDeviceId, setSelectedDeviceId, refetch } = useSensorData();
  const { latestByTank, thresholds } = useDevicesLatest();
  const [showHidden, setShowHidden] = useState(false);
  const [hiddenDevices, setHiddenDevices] = useState<DeviceEntry[] | null>(null);
  const [loadingHidden, setLoadingHidden] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const onlineCount = devices.filter((d) => d.online).length;
  const hiddenCount = hiddenDevices?.length ?? 0;

  const inRange = useCallback((key: string, value: number | null) => {
    if (value === null) return true;
    const t = thresholds[key];
    if (!t) return true;
    return value >= t.range.min && value <= t.range.max;
  }, [thresholds]);

  const valueClass = useCallback((key: string, value: number | null) =>
    inRange(key, value) ? "text-gray-600" : "font-bold text-red-600",
  [inRange]);

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
      await refetch();
    } catch {
      // keep the chip in place; user can retry
    } finally {
      setRestoring(null);
    }
  };

  // Loading state
  if (devicesLoading && devices.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
        Loading tanks...
      </div>
    );
  }

  // No tanks state
  if (devices.length === 0 && !showHidden) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-500">
        No tanks yet — power on an ESP32 and it will appear here automatically.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Tanks</h3>
        <div className="flex items-center gap-3">
          {devices.length > 0 && (
            <span className="text-[11px] text-gray-400">
              {onlineCount}/{devices.length} online
            </span>
          )}
          <button
            type="button"
            onClick={toggleHiddenPanel}
            title={showHidden ? "Close hidden tanks" : "Show hidden tanks"}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-semibold text-gray-500 transition hover:border-orange-300 hover:text-orange-700"
          >
            {showHidden ? <EyeOff size={12} /> : <Eye size={12} />}
            Hidden{hiddenCount > 0 ? ` (${hiddenCount})` : ""}
          </button>
        </div>
      </div>

      {devices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {[...devices]
            .sort((a, b) => a.device_id.localeCompare(b.device_id))
            .map((device) => {
              const active = device.device_id === selectedDeviceId;
              const reading = latestByTank[device.device_id];
              const tempC = reading && reading.temperature != null && reading.temperature > 0 ? reading.temperature : null;
              const water = reading && reading.water_level != null && reading.water_level >= 0 ? reading.water_level : null;
              const ammonia = reading && reading.ammonia != null && reading.ammonia >= 0 ? reading.ammonia : null;

              return (
                <div
                  key={device.device_id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select tank ${deviceLabel(device)}`}
                  onClick={() => setSelectedDeviceId(device.device_id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedDeviceId(device.device_id);
                    }
                  }}
                  className={`group flex min-w-[176px] max-w-full flex-col gap-1.5 rounded-xl border p-3 text-left transition ${
                    active
                      ? "border-orange-500 bg-orange-50"
                      : device.online
                        ? "border-gray-200 bg-white hover:border-orange-300 hover:bg-orange-50/40"
                        : "border-red-200 bg-red-50/40 hover:border-red-300 hover:bg-red-50/70"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          device.online ? "bg-emerald-500" : "bg-red-500"
                        }`}
                      />
                      <p
                        title={device.tank_location ? `${device.device_id} · ${device.tank_location}` : device.device_id}
                        className={`truncate text-sm font-bold ${
                          active ? "text-orange-700" : "text-gray-800"
                        }`}
                      >
                        {deviceLabel(device)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        device.online ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {device.online ? "Online" : "Offline"}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2 text-[11px]">
                    <span className={valueClass("temperature", tempC)}>{tempC !== null ? `${tempC.toFixed(1)} °C` : "-- °C"}</span>
                    <span className="text-gray-300">·</span>
                    <span className={valueClass("water_level", water)}>{water !== null ? `${water.toFixed(0)}%` : "--%"}</span>
                    <span className="text-gray-300">·</span>
                    <span className={valueClass("ammonia", ammonia)}>{ammonia !== null ? `${ammonia.toFixed(2)} ppm` : "-- ppm"}</span>
                  </div>

                  <div className="flex items-center justify-between gap-1.5 transition md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">
                    <div className="flex items-center gap-1.5">
                      <DeviceRename device={device} onSaved={refetch} />
                      <DeviceHide device={device} onHidden={refetch} />
                    </div>
                    <DeviceLiveCheck deviceId={device.device_id} ipAddress={device.ip_address} compact />
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {showHidden && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          {loadingHidden ? (
            <p className="px-1 text-xs text-gray-400">Loading hidden tanks...</p>
          ) : hiddenCount === 0 ? (
            <p className="px-1 text-xs text-gray-400">No hidden tanks.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {hiddenDevices?.map((device) => (
                <div
                  key={device.device_id}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-500"
                >
                  <span className="w-2 h-2 rounded-full bg-gray-300" />
                  <span>{deviceLabel(device)}</span>
                  <button
                    type="button"
                    onClick={() => restore(device.device_id)}
                    disabled={restoring === device.device_id}
                    title={`Restore ${device.device_id}`}
                    className="ml-1 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-orange-700 transition hover:border-orange-300 disabled:opacity-50"
                  >
                    <RotateCcw size={11} className={restoring === device.device_id ? "animate-spin" : ""} />
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}