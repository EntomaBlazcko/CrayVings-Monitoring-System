// Per-tank action controls used by the Live Tank Bar and the Dashboard farm
// grid: inline rename, non-destructive hide, and an on-demand live
// diagnostics check.

import { useState } from "react";
import { Activity, Pencil, Check, X, Loader2, EyeOff, RefreshCw } from "lucide-react";
import { fetchDeviceStatus, updateDevice } from "../api/client";
import type { DeviceEntry, DeviceStatus } from "../types";

export type LiveState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: DeviceStatus };

function fmtLive(key: "temperature" | "water_level" | "ammonia", value: number): string {
  const isReal = key === "temperature" ? value > 0 : value >= 0;
  return isReal ? String(value) : "--";
}

// On-demand poll of one ESP32's GET /status (uptime, RSSI, heap + live values).
// Only triggered on user click - never in a tight poll loop.
export function DeviceLiveCheck({ deviceId, ipAddress, compact }: { deviceId: string; ipAddress: string | null; compact?: boolean }) {
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

  if (live.status === "idle") {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          runCheck();
        }}
        title="Live check (reads the device directly)"
        className="rounded-md border border-gray-200 bg-white p-1 text-gray-400 transition hover:border-orange-300 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 md:min-h-0 md:min-w-000 hover:text-orange-700"
      >
        <Activity size={13} />
      </button>
    );
  }

  if (live.status === "loading") {
    return (
      <span title={`Querying ${ipAddress || deviceId}...`} className="inline-flex items-center gap-1 text-micro text-gray-400">
        <RefreshCw size={11} className="animate-spin" />
        {compact ? "" : "Querying..."}
      </span>
    );
  }

  if (live.status === "error") {
    return (
      <span title={`${live.message} - device may be powered off`} className="inline-flex items-center gap-1 text-micro font-semibold text-red-600">
        <X size={11} />
        {compact ? "No response" : "No response from device"}
      </span>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2 text-xs text-gray-600">
      <p className="font-semibold text-gray-700">Device {live.data.device_id}</p>
      <p>
        Uptime {Math.floor(live.data.uptime_ms / 1000 / 60)}m · RSSI {live.data.wifi_rssi} dBm · Heap{" "}
        {(live.data.free_heap / 1024 / 1024).toFixed(1)} MB
      </p>
      <p>
        {fmtLive("temperature", live.data.temperature)}°C · {fmtLive("water_level", live.data.water_level)}% · {fmtLive("ammonia", live.data.ammonia)} ppm
      </p>
    </div>
  );
}

// Inline rename box beside a tank name. Saves the display label to tank_name
// (the hardware device_id is never changed) then calls onSaved to refetch.
export function DeviceRename({ device, onSaved }: { device: DeviceEntry; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    setValue(device.tank_name || device.name || device.device_id);
    setError(null);
    setEditing(true);
  };

  const close = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateDevice(device.device_id, { tank_name: value.trim() });
      setEditing(false);
      onSaved();
    } catch {
      setError("Could not save — try again");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          save();
        }}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full items-center gap-1.5"
      >
        <input
          autoFocus
          type="text"
          value={value}
          maxLength={60}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
          }}
          placeholder="Tank name"
          className="w-full min-w-0 flex-1 rounded-lg border border-orange-300 bg-white px-2.5 py-1.5 text-sm font-bold text-gray-800 outline-none"
        />
        <button
          type="submit"
          disabled={saving || !value.trim()}
          title="Save name"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-orange-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-orange-700 disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Save
        </button>
        <button
          type="button"
          onClick={(e) => close(e)}
          title="Cancel"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300"
        >
          <X size={12} />
        </button>
        {error && <span className="shrink-0 text-xs text-red-600">{error}</span>}
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      aria-label={`Rename tank ${device.device_id}`}
      title="Rename tank"
      className="rounded-md border border-gray-200 bg-white p-1 text-gray-400 transition hover:border-orange-300 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 md:min-h-0 md:min-w-000 hover:text-orange-700"
    >
      <Pencil size={13} />
    </button>
  );
}

// Hide control with inline confirmation. Hiding removes the tank from the tanks
// section (is_active = false) without deleting its data; it can be restored
// from the Live Tank Bar's "Hidden" panel.
export function DeviceHide({ device, onHidden }: { device: DeviceEntry; onHidden: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  if (confirming) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2 py-1">
        <span className="text-xs font-semibold text-red-700">Hide tank?</span>
        <button
          type="button"
          disabled={saving}
          onClick={async (e) => {
            e.stopPropagation();
            setSaving(true);
            try {
              await updateDevice(device.device_id, { is_active: false });
              onHidden();
            } catch {
              setSaving(false);
            }
          }}
          className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <EyeOff size={11} />}
          Hide
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs font-semibold text-gray-600 transition hover:border-gray-300 disabled:opacity-50"
        >
          <X size={11} />
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setConfirming(true);
      }}
      aria-label={`Hide tank ${device.device_id}`}
      title="Remove from tanks section (data kept, restorable)"
      className="rounded-md border border-gray-200 bg-white p-1 text-gray-400 transition hover:border-red-300 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 md:min-h-0 md:min-w-0 hover:text-red-700"
    >
      <EyeOff size={13} />
    </button>
  );
}