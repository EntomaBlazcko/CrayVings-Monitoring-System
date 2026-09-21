// =============================================================================
// FILE: src/components/FleetGrid.tsx
// =============================================================================
// PURPOSE: Overview of every registered tank (grid of status cards). Uses the
// registry poll (online flags + last_health_seen). Clicking a card selects that
// tank as the active view; the "Live check" button makes an on-demand
// /devices/:id/status call to the ESP32 and shows its real-time diagnostic
// payload (uptime, RSSI, free heap, current sensor readings).
// =============================================================================

import { useState } from "react";
import { Boxes, Activity, RefreshCw } from "lucide-react";
import { useSensorData } from "../hooks/useSensors";
import { formatFarmTime } from "../utils/time";
import { fetchDeviceStatus } from "../api/client";
import type { DeviceEntry, DeviceStatus } from "../types";

function deviceLabel(device: DeviceEntry): string {
  return device.tank_name || device.name || device.device_id;
}

type LiveState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: DeviceStatus };

function DeviceLiveCheck({ deviceId, ipAddress }: { deviceId: string; ipAddress: string | null }) {
  const [live, setLive] = useState<LiveState>({ status: "idle" });

  const runCheck = async () => {
    if (live.status === "loading") return;
    setLive({ status: "loading" });
    try {
      const data = await fetchDeviceStatus(deviceId);
      setLive({ status: "ok", data });
    } catch {
      setLive({ status: "error", message: "No response from device" });
    }
  };

  return (
    <div className="mt-1">
      {live.status === "idle" && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            runCheck();
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-gray-600 transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-50"
        >
          <Activity size={12} />
          Live check
        </button>
      )}
      {live.status === "loading" && (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-400">
          <RefreshCw size={12} className="animate-spin" />
          Querying {ipAddress || deviceId}...
        </span>
      )}
      {live.status === "error" && (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-red-600">
          {live.message} — device may be powered off
        </span>
      )}
      {live.status === "ok" && (
        <div className="rounded-lg border border-gray-200 bg-white p-2.5 text-[11px] text-gray-600 space-y-1">
          <p className="font-semibold text-gray-700">Device {live.data.device_id}</p>
          <p className="flex items-center gap-1">
            <RefreshCw size={10} /> Uptime{" "}
            {Math.floor(live.data.uptime_ms / 1000 / 60)}m · RSSI {live.data.wifi_rssi} dBm · Heap{" "}
            {(live.data.free_heap / 1024 / 1024).toFixed(1)} MB
          </p>
          <p>
            {live.data.temperature}°C · {live.data.water_level}% · {live.data.ammonia} ppm
          </p>
        </div>
      )}
    </div>
  );
}

export default function FleetGrid() {
  const { devices, devicesLoading, setSelectedDeviceId } = useSensorData();

  if (devicesLoading && devices.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Boxes size={16} className="animate-pulse" />
          Loading fleet status...
        </div>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-500">No devices registered yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h3 className="mb-4 text-lg font-bold text-gray-800">Fleet Status</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[...devices]
          .sort((a, b) => a.device_id.localeCompare(b.device_id))
          .map((device) => (
            <button
              key={device.device_id}
              onClick={() => setSelectedDeviceId(device.device_id)}
              className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-gray-50 p-4 text-left transition hover:border-orange-300 hover:bg-orange-50"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-bold text-gray-800">{deviceLabel(device)}</p>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    device.online
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-gray-200 text-gray-500"
                  }`}
                >
                  {device.online ? "Online" : "Offline"}
                </span>
              </div>
              <p className="text-[11px] text-gray-500">
                {device.device_id}
                {device.ip_address ? ` · ${device.ip_address}` : ""}
              </p>
              {device.tank_location && (
                <p className="text-[11px] text-gray-400">{device.tank_location}</p>
              )}
              <p className="text-[11px] text-gray-400">
                Last health:{" "}
                {device.last_health_seen ? formatFarmTime(device.last_health_seen) : "never"}
              </p>
              <DeviceLiveCheck deviceId={device.device_id} ipAddress={device.ip_address} />
            </button>
          ))}
      </div>
    </div>
  );
}