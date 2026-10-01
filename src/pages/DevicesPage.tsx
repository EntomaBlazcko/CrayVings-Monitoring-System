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

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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
  Pencil,
  X,
  KeyRound,
  Copy,
} from "lucide-react";
import { isAxiosError } from "axios";
import { z } from "zod";
import { archiveDevice, createDevice, fetchDevices, restoreDevice, rotateDeviceSecret, updateDevice } from "../api/client";
import { useSensorData, useActivityLogger } from "../hooks/useSensors";
import { DeviceLiveCheck } from "../components/deviceActions";
import { Spinner, ErrorCard } from "../components/Loading";
import { formatTimeAgo } from "../utils/time";
import type { DeviceEntry, DeviceSecretRotation } from "../types";

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

// Editing an existing row sends the same optional fields, minus device_id: the
// hardware ID is the archive key and is deliberately immutable, so the server's
// PUT has no field for it.
const deviceEditSchema = z.object({
  tank_name: z
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

type EditForm = z.infer<typeof deviceEditSchema>;
type EditFormErrors = Partial<Record<keyof EditForm, string>>;

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

// Grace windows offered when rotating a device secret. The 7-day cap is the
// server's own limit, and 0 (revoke now) is the compromise-response option.
const GRACE_OPTIONS = [
  { value: 0, label: "Revoke immediately (old secret dies now)" },
  { value: 1, label: "1 hour (board is at the tank right now)" },
  { value: 24, label: "24 hours (default - a normal rotation)" },
  { value: 72, label: "3 days (board is remote)" },
  { value: 168, label: "7 days (maximum the server allows)" },
];

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

  // Row currently open in the inline editor, plus its own form state. Kept
  // separate from the Add form so the two never overwrite each other's drafts.
  const [editing, setEditing] = useState<DeviceEntry | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ tank_name: "", ip_address: "", tank_location: "" });
  const [editErrors, setEditErrors] = useState<EditFormErrors>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // --- Secret rotation (audit B4) ------------------------------------------
  // Two stages, because the new secret is returned by the server exactly once:
  //   1. open the panel and pick a grace window (how long the OUTGOING secret
  //      keeps working, because a board can only be reconfigured by hand at
  //      its config portal);
  //   2. once issued, show the secret in a copy box that is deliberately NOT
  //      closable into a lost state - dismissing it is an explicit "I'm done,
  //      I've written it down" and the secret can never be shown again.
  const [rotateOpen, setRotateOpen] = useState<string | null>(null);
  const [rotateGrace, setRotateGrace] = useState<number>(24);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  // Set when the server reports the device has no per-device secret yet, i.e. it
  // still authenticates with the shared DEVICE_SECRET. Rotation is meaningless
  // for such a board, so the panel switches to offering the first-secret
  // migration instead of pretending a secret can be replaced.
  const [needsSharedMigration, setNeedsSharedMigration] = useState(false);
  const [issued, setIssued] = useState<DeviceSecretRotation | null>(null);
  const [copied, setCopied] = useState(false);

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

  const openEdit = useCallback((device: DeviceEntry) => {
    setEditing(device);
    setEditForm({
      // An auto-discovered board has never had a name here, so seed the field
      // with its ID - otherwise the editor opens on a required-but-empty box.
      tank_name: device.tank_name || device.name || device.device_id,
      ip_address: device.ip_address || "",
      tank_location: device.tank_location || "",
    });
    setEditErrors({});
    setEditError(null);
  }, []);

  const closeEdit = useCallback(() => {
    setEditing(null);
    setEditErrors({});
    setEditError(null);
  }, []);

  const setEditField = useCallback((key: keyof EditForm, value: string) => {
    setEditForm((prev) => ({ ...prev, [key]: value }));
    setEditErrors((prev) => ({ ...prev, [key]: undefined }));
    setEditError(null);
  }, []);

  const handleEditSave = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!editing) return;
      setEditError(null);

      let parsed: EditForm;
      try {
        parsed = deviceEditSchema.parse(editForm);
      } catch (err) {
        if (err instanceof z.ZodError) {
          const errors: EditFormErrors = {};
          err.issues.forEach((issue) => {
            const key = issue.path[0] as keyof EditForm | undefined;
            if (key && !errors[key]) errors[key] = issue.message;
          });
          setEditErrors(errors);
          return;
        }
        setEditError("Invalid form data");
        return;
      }
      setEditErrors({});
      setEditSaving(true);

      try {
        // ip_address is only sent when non-blank. The server stores whatever
        // string it is given, so an empty string would persist as an empty
        // address while leaving ip_source='manual' - and the ingest upsert
        // refuses to overwrite a manual IP, so the board could never learn its
        // real address again and the poller would skip it forever. Omitting the
        // field leaves the stored IP untouched instead.
        await updateDevice(editing.device_id, {
          tank_name: parsed.tank_name,
          tank_location: parsed.tank_location,
          ...(parsed.ip_address ? { ip_address: parsed.ip_address } : {}),
        });
        logActivity(
          "settings_change",
          `Updated device ${editing.device_id} (name: ${parsed.tank_name})`,
          "devices"
        );
        setEditing(null);
        await load();
        refetch();
      } catch (err) {
        setEditError(getApiError(err));
      } finally {
        setEditSaving(false);
      }
    },
    [editing, editForm, load, logActivity, refetch]
  );

  const openRotate = useCallback((device: DeviceEntry) => {
    setRotateOpen(device.device_id);
    setRotateError(null);
    setCopied(false);
    setNeedsSharedMigration(false);
    // Default back to the forgiving 24h window: the common case is a routine
    // rotation where someone still has to walk over to the tank.
    setRotateGrace(24);
  }, []);

  const closeRotate = useCallback(() => {
    setRotateOpen(null);
    setRotateError(null);
    setNeedsSharedMigration(false);
  }, []);

  const handleRotate = useCallback(async () => {
    if (!rotateOpen) return;
    setRotateBusy(true);
    setRotateError(null);
    try {
      const result = await rotateDeviceSecret(
        rotateOpen,
        needsSharedMigration ? undefined : rotateGrace,
        undefined,
        needsSharedMigration
      );
      setIssued(result);
      setCopied(false);
      setNeedsSharedMigration(false);
      logActivity(
        "settings_change",
        result.first_secret
          ? `Issued a first per-device secret for ${result.device_id} (migrated off the shared secret)`
          : `Rotated the device secret for ${result.device_id}${
              result.previous_secret_revoked
                ? " (previous secret revoked immediately)"
                : ` (previous secret valid for ${result.previous_secret_grace_hours}h)`
            }`,
        "devices"
      );
      await load();
    } catch (err) {
      // A 409 carrying can_migrate_from_shared means the board has no secret of
      // its own yet. Don't show it as a dead end - reframe it as an offer.
      const canMigrate =
        isAxiosError(err) &&
        getStatus(err) === 409 &&
        (err.response?.data as { can_migrate_from_shared?: unknown } | undefined)
          ?.can_migrate_from_shared === true;
      if (canMigrate) {
        setNeedsSharedMigration(true);
        setRotateError(null);
      } else {
        setRotateError(getApiError(err));
      }
    } finally {
      setRotateBusy(false);
    }
  }, [rotateOpen, rotateGrace, needsSharedMigration, load, logActivity]);

  const copySecret = useCallback(async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.device_secret);
      setCopied(true);
    } catch {
      // Clipboard access can be blocked (insecure context, permissions). The
      // secret stays selectable in the box, so tell the user to copy manually
      // rather than silently pretending it worked.
      setCopied(false);
      setRotateError("Could not reach the clipboard - select the secret above and copy it manually.");
    }
  }, [issued]);

  // Dismissing the show-once box discards the secret for good.
  const dismissIssued = useCallback(() => {
    setIssued(null);
    setCopied(false);
    setRotateOpen(null);
  }, []);

  if (loadError && !devices) {
    return <ErrorCard title="Devices" message={loadError} onRetry={load} />;
  }

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- */}
      {/* Show-once secret (audit B4)                                      */}
      {/* ---------------------------------------------------------------- */}
      {issued && (
        <section
          role="alert"
          className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4"
        >
          <h2 className="flex items-center gap-2 text-base font-bold text-amber-900">
            <KeyRound size={18} /> New secret for {issued.device_id} - copy it now
          </h2>
          <p className="mt-1 text-xs text-amber-900">
            This is the only time this secret is ever shown. It is not stored in
            readable form and there is no way to look it up again, so copy it
            into your password manager before closing this box.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-xs text-gray-800">
              {issued.device_secret}
            </code>
            <button
              type="button"
              onClick={copySecret}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-amber-800"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy secret"}
            </button>
          </div>

          <p className="mt-3 text-xs text-amber-900">
            {issued.first_secret ? (
              <>
                This is a <strong>first</strong> secret for this board, so there was no old one to
                expire. The board still works on the shared <span className="font-mono">DEVICE_SECRET</span>
                {issued.devices_still_on_shared_secret
                  ? `, and ${issued.devices_still_on_shared_secret} other active ${
                      issued.devices_still_on_shared_secret === 1 ? "device is" : "devices are"
                    } still using it.`
                  : "."}
              </>
            ) : issued.previous_secret_revoked ? (
              <>
                The previous secret was <strong>revoked immediately</strong>. This board will stop
                reporting until you set the new secret in its WiFi config portal.
              </>
            ) : (
              <>
                The previous secret keeps working until{" "}
                <strong>{formatTimeAgo(new Date(issued.previous_secret_expires_at as string))}</strong>{" "}
                ({issued.previous_secret_grace_hours}h grace window), which gives you time to
                reconfigure the board. After that it stops working on its own.
              </>
            )}
          </p>
          <p className="mt-2 text-xs text-amber-900">
            Next step: open the board&apos;s config portal, paste the new secret
            into the device secret field, and save. Nothing needs to be reflashed.
          </p>

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={dismissIssued}
              className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 transition hover:bg-amber-100"
            >
              I&apos;ve saved it - close
            </button>
          </div>
        </section>
      )}

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
                  This is the <strong>board&apos;s own LAN IP</strong> (e.g. 192.168.1.150), NOT your server IP.
                  The health poller dials http://[this-ip]/status. Find it in the board&apos;s Serial Monitor
                  after it connects to WiFi. Left blank, the server learns it from incoming data (may be NAT IP).
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
                  const isEditing = editing?.device_id === device.device_id;
                  return (
                    <Fragment key={device.device_id}>
                    <tr className="border-b border-gray-100 last:border-0">
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
                          {isEditing ? (
                            <button
                              type="button"
                              onClick={closeEdit}
                              title="Close the editor"
                              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-600 transition hover:border-gray-300"
                            >
                              <X size={12} /> Close
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openEdit(device)}
                              title="Edit name, location and IP address"
                              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-600 transition hover:border-brand-300 hover:text-brand-700"
                            >
                              <Pencil size={12} /> Edit
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => (rotateOpen === device.device_id ? closeRotate() : openRotate(device))}
                            title="Issue a new per-device secret (the old one keeps working for a grace window)"
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                              rotateOpen === device.device_id
                                ? "border-amber-300 bg-amber-50 text-amber-800"
                                : "border-gray-200 bg-white text-gray-600 hover:border-amber-300 hover:text-amber-800"
                            }`}
                          >
                            <KeyRound size={12} /> Secret
                          </button>
                          {confirmArchive === device.device_id ? (
                            <span className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleArchive(device.device_id)}
                                title="Archive: keeps every reading, and the device ID is permanently retired. It can never be registered again - not by this board, not by its replacement."
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
                              {/* The confirmation itself has to carry the
                                  consequence, not just a hover title: archiving
                                  looks reversible from the button alone, and the
                                  ID it burns is the single most permanent thing
                                  on this page. */}
                              <span className="text-[11px] font-medium text-red-700">
                                ID permanently retired
                              </span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setConfirmArchive(device.device_id)}
                              title="Archive this device: every reading is kept and the tank leaves the active views. The device ID is permanently retired and can never be registered again."
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-600 transition hover:border-red-50 disabled:opacity-50"
                            >
                              <Archive size={12} /> Archive
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {isEditing && (
                      <tr>
                        <td colSpan={6} className="border-b border-gray-100 bg-surface-sunken px-4 py-4">
                          <form onSubmit={handleEditSave} className="space-y-3" noValidate>
                            <p className="text-xs text-gray-500">
                              Editing details for{" "}
                              <span className="font-mono text-gray-700">{device.device_id}</span>. The
                              device ID is permanent - it is the archive key and is never reused.
                            </p>

                            <div className="grid gap-3 md:grid-cols-3">
                              <div>
                                <label
                                  htmlFor={`edit-name-${device.device_id}`}
                                  className="block text-sm font-medium text-gray-700 mb-1"
                                >
                                  Device Name <span className="text-red-500">*</span>
                                </label>
                                <input
                                  id={`edit-name-${device.device_id}`}
                                  type="text"
                                  value={editForm.tank_name}
                                  onChange={(e) => setEditField("tank_name", e.target.value)}
                                  maxLength={100}
                                  aria-invalid={!!editErrors.tank_name}
                                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors ${
                                    editErrors.tank_name
                                      ? "border-red-500 bg-red-50"
                                      : "border-gray-300 focus:border-brand-500"
                                  }`}
                                />
                                {editErrors.tank_name && (
                                  <p className="mt-1 text-xs text-red-600">{editErrors.tank_name}</p>
                                )}
                              </div>

                              <div>
                                <label
                                  htmlFor={`edit-ip-${device.device_id}`}
                                  className="block text-sm font-medium text-gray-700 mb-1"
                                >
                                  IP Address{" "}
                                  <span className="text-gray-400 font-normal">
                                    (optional - leave blank to keep current)
                                  </span>
                                </label>
                                <input
                                  id={`edit-ip-${device.device_id}`}
                                  type="text"
                                  inputMode="numeric"
                                  value={editForm.ip_address}
                                  onChange={(e) => setEditField("ip_address", e.target.value)}
                                  aria-invalid={!!editErrors.ip_address}
                                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors ${
                                    editErrors.ip_address
                                      ? "border-red-500 bg-red-50"
                                      : "border-gray-300 focus:border-brand-500"
                                  }`}
                                />
                                {editErrors.ip_address ? (
                                  <p className="mt-1 text-xs text-red-600">{editErrors.ip_address}</p>
                                ) : (
                                  <p className="mt-1 text-xs text-gray-400">
                                    The board&apos;s own LAN IP, not your server IP. Saving this
                                    locks the address (<span className="font-semibold">manual</span>)
                                    so incoming data can no longer overwrite it.
                                  </p>
                                )}
                              </div>

                              <div>
                                <label
                                  htmlFor={`edit-location-${device.device_id}`}
                                  className="block text-sm font-medium text-gray-700 mb-1"
                                >
                                  Location{" "}
                                  <span className="text-gray-400 font-normal">(optional)</span>
                                </label>
                                <input
                                  id={`edit-location-${device.device_id}`}
                                  type="text"
                                  value={editForm.tank_location}
                                  onChange={(e) => setEditField("tank_location", e.target.value)}
                                  maxLength={100}
                                  aria-invalid={!!editErrors.tank_location}
                                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-colors ${
                                    editErrors.tank_location
                                      ? "border-red-500 bg-red-50"
                                      : "border-gray-300 focus:border-brand-500"
                                  }`}
                                />
                                {editErrors.tank_location && (
                                  <p className="mt-1 text-xs text-red-600">{editErrors.tank_location}</p>
                                )}
                              </div>
                            </div>

                            {editError && (
                              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                {editError}
                              </div>
                            )}

                            <div className="flex items-center gap-2">
                              <button
                                type="submit"
                                disabled={editSaving}
                                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-brand-500 to-brand-400 px-4 py-2 text-sm font-semibold text-white transition hover:from-brand-600 hover:to-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {editSaving ? (
                                  <Loader2 size={15} className="animate-spin" />
                                ) : (
                                  <Check size={15} />
                                )}
                                {editSaving ? "Saving..." : "Save changes"}
                              </button>
                              <button
                                type="button"
                                onClick={closeEdit}
                                disabled={editSaving}
                                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 transition hover:border-gray-300 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}

                    {rotateOpen === device.device_id && (
                      <tr>
                        <td colSpan={6} className="border-b border-gray-100 bg-surface-sunken px-4 py-4">
                          <div className="space-y-3">
                            <p className="text-xs text-gray-500">
                              {needsSharedMigration ? (
                                <>
                                  <span className="font-mono text-gray-700">{device.device_id}</span>{" "}
                                  has no secret of its own - it authenticates with the shared{" "}
                                  <span className="font-mono">DEVICE_SECRET</span>. That secret is
                                  fleet-wide, so it cannot be rotated per device. What we can do is
                                  issue this board its own per-device secret and then move it off
                                  the shared one.
                                </>
                              ) : (
                                <>
                                  Rotating the secret for{" "}
                                  <span className="font-mono text-gray-700">{device.device_id}</span>.
                                  A board can only learn a new secret at its WiFi config portal, so
                                  the outgoing secret keeps working for the grace window you pick -
                                  long enough to walk over to the tank.
                                </>
                              )}
                            </p>

                            {!needsSharedMigration && (
                              <div>
                                <label
                                  htmlFor={`rotate-grace-${device.device_id}`}
                                  className="block text-sm font-medium text-gray-700 mb-1"
                                >
                                  Grace window for the old secret
                                </label>
                                <select
                                  id={`rotate-grace-${device.device_id}`}
                                  value={rotateGrace}
                                  disabled={rotateBusy}
                                  onChange={(e) => setRotateGrace(Number(e.target.value))}
                                  className="w-full max-w-sm px-3 py-2 border rounded-lg border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50"
                                >
                                  {GRACE_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                                <p className="mt-1 text-xs text-gray-400">
                                  {rotateGrace === 0
                                    ? "Revoked the moment the new secret is issued. Use this when a secret is suspected compromised - but the board stops reporting until it is reconfigured."
                                    : "The old secret keeps working for this long, then stops on its own. Nothing is scheduled or cleaned up later; the deadline is simply checked at sign-in."}
                                </p>
                              </div>
                            )}

                            {rotateGrace > 0 && !needsSharedMigration && (
                              <p className="flex items-start gap-1.5 text-xs text-amber-700">
                                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                                Reconfigure the board before the window closes, or it will stop
                                reporting. Grace is a hand-off period, not a repair.
                              </p>
                            )}

                            {needsSharedMigration && (
                              <p className="flex items-start gap-1.5 text-xs text-amber-700">
                                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                                This board will keep working on the shared secret too, so this does
                                not reduce your exposure until every device has been moved off it and
                                the shared secret is retired.
                              </p>
                            )}

                            {rotateError && (
                              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                {rotateError}
                              </p>
                            )}

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={rotateBusy}
                                onClick={handleRotate}
                                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-brand-500 to-brand-400 px-4 py-2 text-sm font-semibold text-white transition hover:from-brand-600 hover:to-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {rotateBusy ? (
                                  <Loader2 size={15} className="animate-spin" />
                                ) : (
                                  <KeyRound size={15} />
                                )}
                                {rotateBusy
                                  ? "Working..."
                                  : needsSharedMigration
                                    ? "Issue its first per-device secret"
                                    : rotateGrace === 0
                                      ? "Rotate and revoke old secret"
                                      : "Rotate secret"}
                              </button>
                              <button
                                type="button"
                                onClick={closeRotate}
                                disabled={rotateBusy}
                                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 transition hover:border-gray-300 disabled:opacity-50"
                              >
                                {needsSharedMigration ? "Not now" : "Cancel"}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
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
