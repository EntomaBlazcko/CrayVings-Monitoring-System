// Dashboard "farm grid": one live card per tank (real-time temp / water /
// ammonia, red when out of that tank's EFFECTIVE thresholds, online state,
// last update) with rename / hide / live-check actions on each card. Clicking
// a card selects that tank for every page. Hiding is never destructive —
// hidden tanks are restorable from the panel. Readings + thresholds come from
// the provider's single 5s fleet poll — no per-component fetching here.

import { Boxes, Eye, EyeOff, RotateCcw, TriangleAlert } from "lucide-react";
import { useSensorData, useSensorSettings } from "../hooks/useSensors";
import { useHiddenDevices } from "../hooks/useHiddenDevices";
import { formatFarmTime } from "../utils/time";
import type { DeviceEntry } from "../types";
import { DeviceHide, DeviceLiveCheck, DeviceRename } from "./deviceActions";

function deviceLabel(device: DeviceEntry): string {
  return device.tank_name || device.name || device.device_id;
}

type LiveValue = number | null;

export default function FarmOverview() {
  const { devices, devicesLoading, latestByTank, selectedDeviceId, setSelectedDeviceId, refetch } = useSensorData();
  const { thresholdsFor } = useSensorSettings();
  const { showHidden, hiddenDevices, hiddenCount, loadingHidden, restoring, toggleHiddenPanel, restore } = useHiddenDevices(refetch);

  if (devicesLoading && devices.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Boxes size={16} className="animate-pulse" />
          Loading farm overview...
        </div>
      </div>
    );
  }

  if (devices.length === 0 && !showHidden) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-500">
          No tanks yet — power on an ESP32 and it will appear here automatically.
        </p>
      </div>
    );
  }

  const onlineCount = devices.filter((d) => d.online).length;

  const readValue = (device: DeviceEntry, key: "temperature" | "water_level" | "ammonia"): LiveValue => {
    const reading = latestByTank[device.device_id];
    if (!reading) return null;
    const raw = reading[key];
    if (raw === null || raw === undefined) return null;
    // failure sentinels (-1 / 0) are not real readings
    if (key === "temperature") return raw > 0 ? raw : null;
    return raw >= 0 ? raw : null;
  };

  const isAtRisk = (device: DeviceEntry, key: "temperature" | "water_level" | "ammonia", value: LiveValue) => {
    if (value === null) return false;
    const t = thresholdsFor(device.device_id)[key];
    if (!t) return false;
    return value < t.range.min || value > t.range.max;
  };

  const atRiskCount = devices.filter((device) =>
    (["temperature", "water_level", "ammonia"] as const).some((key) => isAtRisk(device, key, readValue(device, key)))
  ).length;

  const metricTile = (
    label: string,
    display: string,
    atRisk: boolean,
    unitColor: string
  ) => (
    <div
      className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-center ${
        atRisk ? "bg-red-50" : "bg-gray-50"
      }`}
    >
      <span className="text-micro font-bold uppercase tracking-wide text-gray-400">{label}</span>
      <span className={`text-sm leading-tight ${atRisk ? "font-bold text-red-600" : "font-semibold text-gray-700"}`}>
        {display}
      </span>
      <span className="text-micro text-gray-400">{unitColor}</span>
    </div>
  );

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-gray-800">Farm Overview</h3>
          <p className="text-xs text-gray-400">
            {devices.length === 0
              ? "No tanks registered yet"
              : onlineCount === 0
                ? "All tanks offline"
                : `${onlineCount} of ${devices.length} tanks online`}
            {atRiskCount > 0 && (
              <span className="text-red-500"> · {atRiskCount} tank{atRiskCount > 1 ? "s" : ""} with a reading out of range</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleHiddenPanel}
          title={showHidden ? "Close hidden tanks" : "Show hidden tanks"}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-500 transition hover:border-orange-300 hover:text-orange-700"
        >
          {showHidden ? <EyeOff size={12} /> : <Eye size={12} />}
          Hidden{hiddenCount > 0 ? ` (${hiddenCount})` : ""}
        </button>
      </div>

      {devices.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[...devices]
            .sort((a, b) => a.device_id.localeCompare(b.device_id))
            .map((device) => {
              const active = device.device_id === selectedDeviceId;
              const tempC = readValue(device, "temperature");
              const water = readValue(device, "water_level");
              const ammonia = readValue(device, "ammonia");
              const tempAtRisk = isAtRisk(device, "temperature", tempC);
              const waterAtRisk = isAtRisk(device, "water_level", water);
              const ammoniaAtRisk = isAtRisk(device, "ammonia", ammonia);
              const reading = latestByTank[device.device_id];

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
                  className={`group flex flex-col gap-3 rounded-xl border p-4 text-left transition ${
                    active
                      ? "border-orange-500 bg-orange-50/60"
                      : device.online
                        ? "border-gray-200 bg-white hover:border-orange-300 hover:bg-orange-50/30"
                        : "border-red-200 bg-red-50/30 hover:border-red-300 hover:bg-red-50/60"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          device.online ? "bg-emerald-500" : "bg-red-500"
                        }`}
                      />
                      <div className="min-w-0">
                        <p
                          title={device.tank_location ? `${device.device_id} · ${device.tank_location}` : device.device_id}
                          className={`truncate text-sm font-bold ${
                            active ? "text-orange-700" : "text-gray-800"
                          }`}
                        >
                          {deviceLabel(device)}
                        </p>
                        {device.tank_location && (
                          <p className="truncate text-micro text-gray-400">{device.tank_location}</p>
                        )}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-micro font-bold uppercase tracking-wide ${
                        device.online ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {device.online ? "Online" : "Offline"}
                    </span>
                  </div>

                  <div className="flex items-stretch gap-1.5">
                    {metricTile("Temp", tempC !== null ? `${tempC.toFixed(1)}°` : "--", tempAtRisk, "°C")}
                    {metricTile("Water", water !== null ? `${water.toFixed(0)}%` : "--", waterAtRisk, "%")}
                    {metricTile("Ammonia", ammonia !== null ? `${ammonia.toFixed(2)}` : "--", ammoniaAtRisk, "ppm")}
                  </div>

                  {tempAtRisk || waterAtRisk || ammoniaAtRisk ? (
                    <p className="flex items-center gap-1 text-micro font-semibold text-red-600">
                      <TriangleAlert size={11} />
                      Reading outside safe range — check this tank
                    </p>
                  ) : null}

                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-gray-100 pt-2">
                    <span className="text-micro text-gray-400">
                      {device.device_id} · {reading?.recv_at ? `updated ${formatFarmTime(reading.recv_at)}` : "no readings yet"}
                    </span>
                    <div className="flex items-center gap-1.5 transition md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">
                      <DeviceRename device={device} onSaved={refetch} />
                      <DeviceLiveCheck deviceId={device.device_id} ipAddress={device.ip_address} compact />
                      <DeviceHide device={device} onHidden={refetch} />
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {showHidden && (
        <div className="mt-4 border-t border-gray-100 pt-3">
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
                    className="ml-1 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-orange-700 transition hover:border-orange-300 disabled:opacity-50"
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
