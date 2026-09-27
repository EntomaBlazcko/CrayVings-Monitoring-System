// Devices page - the device registry: register a new board, see the whole
// fleet, and archive a retired device without destroying its history.
//
// Registration is a manual, offline-adjacent process: the team flashes each
// ESP32 by hand, so nothing here uploads firmware or talks to a board. This page
// only records the identity the board will push under, plus the metadata the
// server needs to reach it (the health poller dials http://<ip>/status).
//
// Two distinct "removal" concepts, deliberately kept separate:
//   Hide    (is_active = false) - reversible, "don't show this right now"
//   Archive (archived_at set)   - terminal, "this board is retired"
// Archiving keeps every reading the device ever produced, so a retired board can
// still be restored, and its ID is never released to another board.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cpu,
  Plus,
  Archive,
  RotateCcw,
  Loader2,
  Check,
  AlertTriangle,
  RefreshCw,
  Wifi,
  WifiOff,
  ShieldCheck,
} from "lucide-react";
import { isAxiosError } from "axios";
import { z } from "zod";
import { archiveDevice, createDevice, fetchDevices, restoreDevice } from "../api/client";
import { useSensorData, useActivityLogger } from "../hooks/useSensors";
import { DeviceLiveCheck } from "../components/deviceActions";
import { Spinner, ErrorCard } from "../components/Loading";
import { formatTimeAgo } from "../utils/time";
import type { DeviceEntry } from "../types";

// Mirrors the server-side createDeviceSchema so the Owner gets instant feedback,
// while the server remains the authority (it re-validates every field).
const deviceFormSchema = z.object({
  device_id: z
    .string()
    .trim()
    .min(1, "Device ID is required")
    .max(50, "Device ID must be 50 characters or fewer")
    .regex(/^[A-Za-z0-9._-]+$/, "Use only letters, numbers, dots, dashes and underscores"),
  device_name: z
    .string()
    .trim()
    .min(1, "Device name is required")
    .max(100, "Device name must be 100 characters or fewer"),
  ip_address: z
    .string()
    .trim()
    .refine((v) => {
      if (!v) return true; // optional
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
      return !!m && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
    }, "Enter a valid IPv4 address (e.g. 192.168.100.27)"),
  tank_location: z.string().trim().max(100, "Location must be 100 characters or fewer"),
});

type DeviceForm = z.infer<typeof deviceFormSchema>;
type FormErrors = Partial<Record<keyof DeviceForm, string>>;

const EMPTY_FORM: DeviceForm = {
  device_id: "",
  device_name: "",
  ip_address: "",
  tank_location: "",
};

// Server field-errors ({ device_id: ["..."] }) flattened to a single message.
function fieldMessage(errors: unknown, key: string): string | undefined {
  if (!errors || typeof errors !== "object") return undefined;
  const value = (errors as Record<string, unknown>)[key];
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

// The client rejects with the raw AxiosError (see the response interceptor in
// api/client.ts, which rewrites error.message from the server's { message }), so
// this follows the same getApiError convention as SettingsPage.
function getApiError(err: unknown): string {
  if (isAxiosError(err)) {
    const data = err.response?.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string") return data.message;
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

function getStatus(err: unknown): number | undefined {
  return isAxiosError(err) ? err.response?.status : undefined;
}

// Server-side per-field validation errors, when present.
function getFieldErrors(err: unknown): unknown {
  if (!isAxiosError(err)) return undefined;
  return (err.response?.data as { errors?: unknown } | undefined)?.errors;
}

function OnlineDot({ online }: { online: boolean }) {
  return online ? (
    <span title="Online — reported recently" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
      <Wifi size={13} /> Online
    </span>
  ) : (
    <span title="Offline — no recent reading" className="inline-flex items-center gap-1 text-xs font-semibold text-gray-400">
      <WifiOff size={13} /> Offline
    </span>
  );
}

export default function DevicesPage() {
  const { refetch } = useSensorData();
  const logActivity = useActivityLogger();

  const [devices, setDevices] = useState<DeviceEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [form, setForm] = useState<DeviceForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  // device_id currently being archived / restored, for per-row spinners.
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // includeHidden so hidden tanks stay visible here (this is the registry,
      // not the monitoring view); includeArchived only when the Owner asks,
      // because asking for the archive implies "show me all of it".
      setDevices(await fetchDevices(true, undefined, showArchived));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load devices");
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const activeDevices = useMemo(
    () => (devices ?? []).filter((d) => !d.archived_at),
    [devices]
  );
  const archivedDevices = useMemo(
    () => (devices ?? []).filter((d) => d.archived_at),
    [devices]
  );
  // A board that only ever auto-registered itself was never added by hand, so it
  // has no name/IP until an Owner claims it. Worth surfacing rather than leaving
  // as an anonymous row.
  const needsAttention = useMemo(
    () => activeDevices.filter((d) => d.registered_via === "auto"),
    [activeDevices]
  );

  const setField = useCallback((key: keyof DeviceForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFormErrors((prev) => ({ ...prev, [key]: undefined }));
    setSubmitError(null);
    setSuccess(null);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitError(null);
      setSuccess(null);

      let parsed: DeviceForm;
      try {
        parsed = deviceFormSchema.parse(form);
      } catch (err) {
        if (err instanceof z.ZodError) {
          const errors: FormErrors = {};
          err.issues.forEach((issue) => {
            const key = issue.path[0] as keyof DeviceForm | undefined;
            if (key && !errors[key]) errors[key] = issue.message;
          });
          setFormErrors(errors);
          return;
        }
        setSubmitError("Invalid form data");
        return;
      }
      setFormErrors({});
      setSubmitting(true);

      try {
        const created = await createDevice({
          device_id: parsed.device_id,
          device_name: parsed.device_name,
          // Blank means "not supplied" - the server then lets ingestion learn it.
          ...(parsed.ip_address ? { ip_address: parsed.ip_address } : {}),
          ...(parsed.tank_location ? { tank_location: parsed.tank_location } : {}),
        });
        setForm(EMPTY_FORM);
        setSuccess(`Registered ${created.device_id}`);
        logActivity("form_submit", `Registered device ${created.device_id} (${created.tank_name})`, "devices");
        await load();
        refetch();
      } catch (err) {
        const status = getStatus(err);
        const onField = fieldMessage(getFieldErrors(err), "device_id");
        // 409 = the device ID is taken. Show it on the field itself rather than
        // as a generic banner, and keep the server's wording: it distinguishes a
        // live device from a retired one, which is the difference between "pick
        // another ID" and "this ID can never be used again".
        if (status === 409) {
          setFormErrors((prev) => ({ ...prev, device_id: onField ?? getApiError(err) }));
        } else {
          setSubmitError(getApiError(err));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [form, load, logActivity, refetch]
  );

  const handleArchive = useCallback(
    async (deviceId: string) => {
      setBusyDevice(deviceId);
      setRowError(null);
      try {
        const result = await archiveDevice(deviceId);
        setConfirmArchive(null);
        logActivity(
          "settings_change",
          `Archived device ${deviceId} (${result.retained_readings} readings retained)`,
          "devices"
        );
        await load();
        refetch();
      } catch (err) {
        setRowError(getApiError(err));
      } finally {
        setBusyDevice(null);
      }
    },
    [load, logActivity, refetch]
  );

  const handleRestore = useCallback(
    async (deviceId: string) => {
      setBusyDevice(deviceId);
      setRowError(null);
      try {
        await restoreDevice(deviceId);
        logActivity("settings_change", `Restored device ${deviceId}`, "devices");
        await load();
        refetch();
      } catch (err) {
        setRowError(getApiError(err));
      } finally {
        setBusyDevice(null);
      }
    },
    [load, logActivity, refetch]
  );

  if (loadError && !devices) {
    return <ErrorCard title="Devices" message={loadError} onRetry={load} />;
  }

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- */}
      {/* Add Device                                                        */}
      {/* ---------------------------------------------------------------- */}
      <section className="rounded-xl border border-surface-sunken-border bg-white p-4">
        <h2 className="flex items-center gap-2 text-base font-bold text-gray-800">
          <Plus size={18} className="text-brand-500" /> Add Device
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Registers a board your team has already flashed. Firmware is never
          uploaded here - add the identity the board was compiled with, then it
          can start reporting. Device IDs must be unique and are never reused,
          even after a device is archived.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3" noValidate>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="device-id" className="block text-sm font-medium text-gray-700 mb-1">
                Device ID <span className="text-red-500">*</span>
              </label>
              <input
                id="device-id"
                type="text"
                value={form.device_id}
                onChange={(e) => setField("device_id", e.target.value)}
                placeholder="ESP32_06"
                maxLength={50}
                aria-invalid={!!formErrors.device_id}
                className={`w-full px-3 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors ${
                  formErrors.device_id ? "border-red-500 bg-red-50" : "border-gray-300 focus:border-brand-500"
                }`}
              />
              {formErrors.device_id && (
                <p className="mt-1 text-xs text-red-600">{formErrors.device_id}</p>
              )}
            </div>

            <div>
              <label htmlFor="device-name" className="block text-sm font-medium text-gray-700 mb-1">
                Device Name <span className="text-red-500">*</span>
              </label>
              <input
                id="device-name"
                type="text"
                value={form.device_name}
                onChange={(e) => setField("device_name", e.target.value)}
                placeholder="Tank 6 - East Bay"
                maxLength={100}
                aria-invalid={!!formErrors.device_name}
                className={`w-full px-3 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors ${
                  formErrors.device_name ? "border-red-500 bg-red-50" : "border-gray-300 focus:border-brand-500"
                }`}
              />
              {formErrors.device_name && (
                <p className="mt-1 text-xs text-red-600">{formErrors.device_name}</p>
              )}
            </div>

            <div>
              <label htmlFor="device-ip" className="block text-sm font-medium text-gray-700 mb-1">
                IP Address <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                id="device-ip"
                type="text"
                inputMode="numeric"
                value={form.ip_address}
                onChange={(e) => setField("ip_address", e.target.value)}
                placeholder="192.168.100.27"
                aria-invalid={!!formErrors.ip_address}
                className={`w-full px-3 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors ${
                  formErrors.ip_address ? "border-red-500 bg-red-50" : "border-gray-300 focus:border-brand-500"
                }`}
              />
              {formErrors.ip_address ? (
                <p className="mt-1 text-xs text-red-600">{formErrors.ip_address}</p>
              ) : (
                <p className="mt-1 text-xs text-gray-400">
                  Set this to the board&apos;s static LAN address so health checks can reach it. Left
                  blank, the server learns it from incoming data.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="device-location" className="block text-sm font-medium text-gray-700 mb-1">
                Location <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                id="device-location"
                type="text"
                value={form.tank_location}
                onChange={(e) => setField("tank_location", e.target.value)}
                placeholder="North Bay"
                maxLength={100}
                aria-invalid={!!formErrors.tank_location}
                className={`w-full px-3 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors ${
                  formErrors.tank_location ? "border-red-500 bg-red-50" : "border-gray-300 focus:border-brand-500"
                }`}
              />
              {formErrors.tank_location && (
                <p className="mt-1 text-xs text-red-600">{formErrors.tank_location}</p>
              )}
            </div>
          </div>

          {submitError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {submitError}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              <Check size={15} /> {success}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-brand-500 to-brand-400 px-4 py-2.5 text-sm font-semibold text-white transition hover:from-brand-600 hover:to-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {submitting ? "Registering..." : "Add Device"}
          </button>
        </form>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Fleet                                                             */}
      {/* ---------------------------------------------------------------- */}
      <section className="rounded-xl border border-surface-sunken-border bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-bold text-gray-800">
            <Cpu size={18} className="text-brand-500" /> Registered Devices
            <span className="text-sm font-semibold text-gray-400">({activeDevices.length} active)</span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                showArchived
                  ? "border-brand-300 bg-brand-50 text-brand-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-brand-300"
              }`}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
            <button
              type="button"
              onClick={load}
              title="Refresh"
              className="rounded-lg border border-gray-200 bg-white p-2 text-gray-400 transition hover:border-brand-300 hover:text-brand-700"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {needsAttention.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {needsAttention.length} device{needsAttention.length > 1 ? "s" : ""} reported data without
              being registered here ({needsAttention.map((d) => d.device_id).join(", ")}). Add the missing
              details with the pencil icon on each row, or archive the ones you do not use.
            </span>
          </div>
        )}

        {rowError && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {rowError}
          </div>
        )}

        {loading && !devices ? (
          <div className="mt-4 flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
            <Spinner /> Loading devices...
          </div>
        ) : activeDevices.length === 0 && archivedDevices.length === 0 ? (
          <p className="mt-4 rounded-lg bg-surface-sunken px-3 py-6 text-center text-sm text-gray-500">
            No devices registered yet. Add your first ESP32 above.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-3 font-semibold">Device</th>
                  <th className="py-2 pr-3 font-semibold">IP Address</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold">Last Seen</th>
                  <th className="py-2 pr-3 font-semibold">Source</th>
                  <th className="py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeDevices.map((device) => {
                  const isBusy = busyDevice === device.device_id;
                  const isHidden = !device.is_active;
                  return (
                    <tr key={device.device_id} className="border-b border-gray-100 last:border-0">
                      <td className="py-2.5 pr-3">
                        <div className="font-semibold text-gray-800">
                          {device.tank_name || device.name || device.device_id}
                        </div>
                        <div className="font-mono text-xs text-gray-500">{device.device_id}</div>
                        {device.tank_location && (
                          <div className="text-xs text-gray-400">{device.tank_location}</div>
                        )}
                        {isHidden && (
                          <span className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-500">
                            Hidden
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-gray-600">
                        {device.ip_address || <span className="text-gray-400">not set</span>}
                        {device.ip_source === "manual" && (
                          <span
                            title="Registered by an owner - incoming data will not overwrite this address"
                            className="ml-1 inline-flex items-center gap-0.5 rounded bg-brand-50 px-1 py-0.5 text-[10px] font-semibold text-brand-700"
                          >
                            <ShieldCheck size={9} /> manual
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <OnlineDot online={device.online} />
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-gray-500">
                        {device.last_seen ? formatTimeAgo(new Date(device.last_seen)) : "never"}
                      </td>
                      <td className="py-2.5 pr-3">
                        {device.registered_via === "manual" ? (
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                            Registered
                          </span>
                        ) : (
                          <span
                            title="Auto-discovered: this board sent data but was never added here"
                            className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700"
                          >
                            Auto-discovered
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <DeviceLiveCheck deviceId={device.device_id} ipAddress={device.ip_address} compact />
                          {confirmArchive === device.device_id ? (
                            <span className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleArchive(device.device_id)}
                                title="Archive: keeps all data, retires the device"
                                className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
                              >
                                {isBusy ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />}
                                Confirm
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => setConfirmArchive(null)}
                                className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-600 transition hover:border-gray-300"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setConfirmArchive(device.device_id)}
                              title="Archive this device (data and readings are kept)"
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                            >
                              <Archive size={12} /> Archive
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {showArchived &&
                  archivedDevices.map((device) => {
                    const isBusy = busyDevice === device.device_id;
                    return (
                      <tr key={device.device_id} className="border-b border-gray-100 last:border-0 bg-surface-sunken">
                        <td className="py-2.5 pr-3">
                          <div className="font-semibold text-gray-500 line-through">
                            {device.tank_name || device.name || device.device_id}
                          </div>
                          <div className="font-mono text-xs text-gray-400">{device.device_id}</div>
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs text-gray-400">
                          {device.ip_address || "--"}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-600">
                            Archived
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-gray-400">
                          {device.archived_at ? `by ${device.archived_by || "unknown"}` : "--"}
                          <div className="text-[10px]">
                            {device.archived_at ? formatTimeAgo(new Date(device.archived_at)) : ""}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-gray-400">All readings kept</td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleRestore(device.device_id)}
                            title="Bring this device back into service"
                            className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-white px-2 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
                          >
                            {isBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                            Restore
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
