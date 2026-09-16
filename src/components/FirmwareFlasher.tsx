// =============================================================================
// FILE: src/components/FirmwareFlasher.tsx
// PURPOSE: ESP32 web flasher (esptool-js / Web Serial API), embedded into the
//          Settings page. Rendered only for admin/owner accounts by SettingsPage.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Usb,
  PlugZap,
  Plug,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Wifi,
  Info,
} from "lucide-react";
import { useEspFlasher } from "../hooks/useEspFlasher";
import type { FirmwareManifest, FlashStatus } from "../hooks/useEspFlasher";
import { Spinner } from "./Loading";
import { useActivityLogs } from "../contexts/SensorContext";

const STATUS_LABELS: Record<FlashStatus, string> = {
  idle: "Not Connected",
  connecting: "Connecting…",
  connected: "Connected",
  flashing: "Flashing…",
  done: "Flash Complete",
  error: "Flash Failed",
};

export default function FirmwareFlasher() {
  const { logActivity } = useActivityLogs();

  const {
    isSupported,
    status,
    progress,
    logMessages,
    error,
    chipInfo,
    connect,
    disconnect,
    flash,
    abort,
  } = useEspFlasher();

  const [manifest, setManifest] = useState<FirmwareManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [selectedBuild, setSelectedBuild] = useState(0);

  // Load the firmware manifest from /firmware/manifest.json.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/firmware/manifest.json");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data: FirmwareManifest = await res.json();
        if (!cancelled) setManifest(data);
      } catch (err) {
        if (!cancelled) {
          setManifestError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setManifestLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Log connect / flash completion to the activity log on status transitions.
  const prevStatusRef = useRef<FlashStatus | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (status === "connected" && prev !== "connected") {
      logActivity(
        "device_connect",
        "Connected ESP32 serial port for firmware flash",
        "Firmware Flasher"
      );
    }
    if (status === "done" && prev === "flashing") {
      logActivity(
        "device_disconnect",
        "ESP32 firmware updated via web flasher",
        "Firmware Flasher"
      );
    }
    prevStatusRef.current = status;
  }, [status, logActivity]);

  const handleFlash = useCallback(async () => {
    const build = manifest?.builds[selectedBuild];
    if (!build) return;
    await flash(build);
  }, [manifest, selectedBuild, flash]);

  const statusColor =
    status === "connected" || status === "done"
      ? "bg-green-300"
      : status === "flashing" || status === "connecting"
        ? "bg-yellow-300 animate-pulse"
        : status === "error"
          ? "bg-red-400"
          : "bg-gray-200";

  const buttonBase =
    "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center shrink-0">
            <Usb size={18} />
          </span>
          <div>
            <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
              Firmware Flasher
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 border border-gray-200 text-gray-600">
                <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
                {STATUS_LABELS[status]}
              </span>
            </h3>
            <p className="text-xs text-gray-500">
              Flash or update the ESP32 device (owner &amp; admin only)
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] text-gray-400 shrink-0">
          <Wifi size={12} />
          USB + Chrome/Edge
        </span>
      </div>

      {!isSupported && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2 text-sm">
          <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-red-700">
            Web Serial API is not supported in this browser. Use{" "}
            <a
              href="https://www.google.com/chrome/"
              target="_blank"
              rel="noreferrer"
              className="underline font-semibold"
            >
              Chrome
            </a>{" "}
            or{" "}
            <a
              href="https://www.microsoft.com/edge"
              target="_blank"
              rel="noreferrer"
              className="underline font-semibold"
            >
              Edge
            </a>{" "}
            (HTTPS or localhost required).
          </p>
        </div>
      )}

      {isSupported && (
        <div className="space-y-3">
          {(status === "error" || error) && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4">
              <div className="flex items-start gap-3">
                <span className="w-8 h-8 rounded-lg bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                  <AlertTriangle size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-bold text-red-800">
                    {error?.title ?? "Flash error"}
                  </h4>
                  <p className="mt-1 text-sm text-red-700 leading-relaxed">
                    {error?.message ?? "The flashing operation encountered an error."}
                  </p>
                  {error?.tip && (
                    <div className="mt-2 flex items-start gap-2 text-red-600">
                      <Info size={14} className="shrink-0 mt-0.5" />
                      <p className="text-xs leading-relaxed">{error.tip}</p>
                    </div>
                  )}
                  {error?.detail && (
                    <p className="mt-2 font-mono text-[11px] text-red-400 break-all">
                      {error.detail}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Connect */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center text-[10px] font-bold">
                1
              </span>
              <p className="text-xs font-bold text-gray-800 uppercase tracking-wide">
                Connect Device
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {chipInfo ? (
                  <div className="text-sm space-y-0.5">
                    <p className="text-gray-800">
                      <span className="font-semibold">Chip:</span>{" "}
                      {chipInfo.description || chipInfo.name}
                    </p>
                    <p className="text-gray-500">
                      <span className="font-semibold">Flash:</span>{" "}
                      {chipInfo.flashSize}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">
                    No device connected. Plug in the ESP32 via USB and click
                    Connect.
                  </p>
                )}
              </div>
              {status === "connecting" ? (
                <button disabled className={`${buttonBase} bg-orange-500 text-white`}>
                  <Spinner size={14} /> Connecting…
                </button>
              ) : status === "connected" || status === "done" || status === "flashing" ? (
                <button
                  onClick={disconnect}
                  disabled={status === "flashing"}
                  className={`${buttonBase} border border-gray-300 text-gray-600 hover:bg-gray-100`}
                >
                  <Plug size={14} /> Disconnect
                </button>
              ) : (
                <button
                  onClick={connect}
                  className={`${buttonBase} bg-orange-500 hover:bg-orange-600 text-white`}
                >
                  <PlugZap size={14} /> Connect Device
                </button>
              )}
            </div>
          </div>

          {/* Step 2: Select firmware */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center text-[10px] font-bold">
                2
              </span>
              <p className="text-xs font-bold text-gray-800 uppercase tracking-wide">
                Select Firmware
              </p>
            </div>

            {manifestLoading && (
              <p className="text-sm text-gray-500 flex items-center gap-2">
                <Spinner size={14} /> Loading firmware manifest…
              </p>
            )}

            {!manifestLoading && manifestError && (
              <div className="flex items-start gap-2 text-sm text-amber-700">
                <Info size={16} className="shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">No firmware available yet.</p>
                  <p className="text-amber-600 mt-1">
                    The manifest is missing or not compiled yet (
                    {manifestError}). Compile water_monitoring_system.ino in
                    Arduino IDE (Sketch &gt; Export Compiled Binary) and copy the
                    3 .bin files into public/firmware/ with the manifest.
                  </p>
                </div>
              </div>
            )}

            {manifest && (
              <div className="space-y-2">
                {manifest.builds.map((build, index) => {
                  const selected = index === selectedBuild;
                  return (
                    <button
                      key={build.name}
                      onClick={() => setSelectedBuild(index)}
                      disabled={status === "flashing"}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition ${
                        selected
                          ? "bg-orange-50 border-orange-300 ring-1 ring-orange-300"
                          : "bg-white border-gray-200 hover:bg-gray-50"
                      } disabled:opacity-60`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-gray-800 truncate">
                          {build.name}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {build.description}
                        </p>
                      </div>
                      {selected && (
                        <CheckCircle2 size={18} className="text-orange-500 ml-auto shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step 3: Flash */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center text-[10px] font-bold">
                3
              </span>
              <p className="text-xs font-bold text-gray-800 uppercase tracking-wide">
                Flash
              </p>
            </div>

            {(status === "flashing" || status === "done") && (
              <div className="mb-3">
                <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                  <span>
                    {status === "done" ? "Complete" : "Writing firmware…"}
                  </span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2.5 w-full bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-orange-500 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {status === "flashing" ? (
                <button
                  onClick={abort}
                  className={`${buttonBase} bg-gray-800 hover:bg-gray-900 text-white`}
                >
                  <RefreshCw size={14} /> Abort
                </button>
              ) : (
                <button
                  onClick={handleFlash}
                  disabled={!chipInfo || !manifest || status === "connecting"}
                  className={`${buttonBase} bg-orange-500 hover:bg-orange-600 text-white`}
                >
                  <PlugZap size={14} /> Flash Firmware
                </button>
              )}
              {status === "done" && (
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
                  <CheckCircle2 size={16} /> Flash complete! Device is
                  restarting.
                </span>
              )}
            </div>
          </div>

          {/* Terminal Output */}
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Terminal size={14} className="text-gray-400" />
              <p className="text-xs font-bold text-gray-800 uppercase tracking-wide">
                Terminal Output
              </p>
            </div>
            <div className="bg-gray-900 text-green-400 font-mono text-xs rounded-xl p-4 h-44 overflow-y-auto whitespace-pre-wrap">
              {logMessages.length > 0 ? (
                logMessages.map((line, index) => (
                  <div key={index}>{line}</div>
                ))
              ) : (
                <span className="text-gray-500">
                  Waiting for a device connection…
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}