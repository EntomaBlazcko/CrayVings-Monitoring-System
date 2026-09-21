// =============================================================================
// FILE: src/components/TankSelector.tsx
// =============================================================================
// PURPOSE: Fleet-wide tank switcher. Shows every registered device as a chip
// with an online/offline dot; clicking one makes it the selected tank for the
// Dashboard / Historical Data / Analytics pages.
// =============================================================================

import { useSensorData } from "../hooks/useSensors";
import type { DeviceEntry } from "../types";

function deviceLabel(device: DeviceEntry): string {
  return device.tank_name || device.name || device.device_id;
}

export default function TankSelector() {
  const { devices, devicesLoading, selectedDeviceId, setSelectedDeviceId } = useSensorData();

  if (devicesLoading && devices.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
        Loading devices...
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-500">
        No devices registered. Register ESP32s in the system to begin monitoring.
      </div>
    );
  }

  const onlineCount = devices.filter((d) => d.online).length;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">Tanks</h3>
        <span className="text-[11px] text-gray-400">
          {onlineCount}/{devices.length} online
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {[...devices]
          .sort((a, b) => a.device_id.localeCompare(b.device_id))
          .map((device) => {
            const active = device.device_id === selectedDeviceId;
            return (
              <button
                key={device.device_id}
                onClick={() => setSelectedDeviceId(device.device_id)}
                title={device.tank_location ? `${device.device_id} · ${device.tank_location}` : device.device_id}
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                  active
                    ? "border-orange-500 bg-orange-50 text-orange-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    device.online ? "bg-emerald-500" : "bg-gray-300"
                  }`}
                />
                {deviceLabel(device)}
              </button>
            );
          })}
      </div>
    </div>
  );
}