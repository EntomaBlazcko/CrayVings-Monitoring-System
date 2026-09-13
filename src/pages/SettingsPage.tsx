// =============================================================================
// src/pages/SettingsPage.tsx
// Settings page: alert thresholds, and user management.
// =============================================================================

import { useState, useCallback, useMemo, useEffect } from "react";
import { isAxiosError } from "axios";
import { useSensorSettings, useActivityLogger } from "../hooks/useSensors";
import { useAuth } from "../contexts/useAuth";
import {
  Settings,
  Save,
  AlertTriangle,
  Lock,
  UserPlus,
  Trash2,
  KeyRound,
  Shield,
  User,
  X,
  Eye,
  EyeOff,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Thermometer,
  Waves,
  FlaskConical,
  SlidersHorizontal,
  Users,
  MessageSquare,
  Send,
  Bell,
  BellOff,
  Pencil,
  Check,
  ScrollText,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { SensorSettings } from "../types";
import { DEFAULT_SETTINGS, getSettingsThresholds } from "../types";
import { LoadingCard } from "../components/Loading";
import { formatFarmDate, formatFarmDateTime } from "../utils/time";
import { z } from "zod";
import {
  fetchUsers,
  createUser,
  requestUserDeletion,
  verifyUserDeletion,
  resetUserPassword,
  resetSettings as apiResetSettings,
  fetchSmsRecipients,
  addSmsRecipient,
  updateSmsRecipient,
  deleteSmsRecipient,
  sendTestSms,
  sendStatusSms,
  setSmsMute,
  fetchSmsMuteStatus,
  fetchSmsLogs,
  fetchSmsHealth,
} from "../api/client";
import type { UserEntry, SmsRecipient, MuteStatus, SmsLogEntry, SmsHealth } from "../api/client";

const getApiError = (err: unknown): string => {
  if (isAxiosError(err)) return err.response?.data?.message ?? err.message;
  return err instanceof Error ? err.message : "An unexpected error occurred";
};

const SETTING_BOUNDS: Record<string, { min: number; max: number }> = {
  temp_min: { min: -10, max: 50 },
  temp_max: { min: -10, max: 50 },
  water_level_min: { min: 0, max: 100 },
  water_level_max: { min: 0, max: 100 },
  ammonia_min: { min: 0, max: 500 },
  ammonia_max: { min: 0, max: 500 },
};

const KEY_MAPPING: Record<string, { min: keyof SensorSettings; max: keyof SensorSettings }> = {
  temperature: { min: "temp_min", max: "temp_max" },
  water_level: { min: "water_level_min", max: "water_level_max" },
  ammonia: { min: "ammonia_min", max: "ammonia_max" },
};

const THRESHOLD_COLORS: Record<string, { bg: string; border: string }> = {
  temperature: { bg: "bg-orange-50", border: "border-orange-100" },
  water_level: { bg: "bg-blue-50", border: "border-blue-100" },
  ammonia: { bg: "bg-emerald-50", border: "border-emerald-100" },
};

const THRESHOLD_META: Record<string, { icon: typeof Thermometer; tint: string }> = {
  temperature: { icon: Thermometer, tint: "text-orange-500" },
  water_level: { icon: Waves, tint: "text-blue-500" },
  ammonia: { icon: FlaskConical, tint: "text-emerald-500" },
};

// Visual labels for sms_logs.status values
const SMS_STATUS_BADGES: Record<string, { label: string; cls: string; dot?: string; hint?: string }> = {
  delivered: { label: "Delivered", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200", dot: "bg-emerald-500" },
  failed: { label: "Failed", cls: "bg-red-50 text-red-700 border border-red-200", dot: "bg-red-500" },
  queued: { label: "Queued", cls: "bg-yellow-50 text-yellow-700 border border-yellow-200", dot: "bg-yellow-500" },
  capped: { label: "Capped", cls: "bg-gray-100 text-gray-500 border border-gray-200", hint: "Daily SMS budget reached — not sent" },
  sent: { label: "Sent", cls: "bg-blue-50 text-blue-700 border border-blue-200", hint: "Logged before delivery tracking existed" },
};

// Converts the stored E.164 phone (+639XXXXXXXXX) to the local 09XXXXXXXXX form
// for display in the SMS Logs. Foreign numbers are shown as stored.
function formatDisplayPhone(phone: string): string {
  return phone.startsWith("+63") && phone.length === 13 ? `0${phone.slice(3)}` : phone;
}

// Mini range visualization showing the configured min/max within allowed bounds.
function RangeTrack({
  min,
  max,
  bounds,
  invalid,
}: {
  min: number;
  max: number;
  bounds: { min: number; max: number };
  invalid: boolean;
}) {
  const span = bounds.max - bounds.min;
  const pos = (v: number) => (span > 0 ? Math.min(Math.max(((v - bounds.min) / span) * 100, 0), 100) : 0);
  const left = pos(min);
  const right = pos(max);
  const width = Math.max(right - left, 0);
  return (
    <div className="relative h-1.5 rounded-full bg-gray-200">
      <div
        className={`absolute top-0 bottom-0 rounded-full ${invalid ? "bg-red-400" : "bg-emerald-400"}`}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
      <div className="absolute w-2 h-2 rounded-full bg-white border-2 border-gray-400 -translate-x-1/2" style={{ left: `${left}%`, top: -3 }} />
      <div className="absolute w-2 h-2 rounded-full bg-white border-2 border-gray-400 -translate-x-1/2" style={{ left: `${right}%`, top: -3 }} />
    </div>
  );
}

const SETTINGS_FIELDS: Array<keyof SensorSettings> = [
  "temp_min",
  "temp_max",
  "water_level_min",
  "water_level_max",
  "ammonia_min",
  "ammonia_max",
];

const userSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  username: z.string().min(3, "Username must be at least 3 characters").max(50).regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
  email: z.string().email("Please enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100)
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  role: z.enum(["user", "admin"]),
});

type UserForm = z.infer<typeof userSchema>;
type FormErrors = Record<string, string>;

function validateSetting(key: keyof SensorSettings, value: number): { valid: boolean; message?: string } {
  const bounds = SETTING_BOUNDS[key];
  if (!bounds) return { valid: true };

  if (value < bounds.min || value > bounds.max) {
    return {
      valid: false,
      message: `Value must be between ${bounds.min} and ${bounds.max}`,
    };
  }

  return { valid: true };
}

function validateRange(key: string, settingsToValidate: SensorSettings): { valid: boolean; message?: string } {
  const keys = KEY_MAPPING[key];
  if (!keys) return { valid: true };

  const min = settingsToValidate[keys.min];
  const max = settingsToValidate[keys.max];

  if (typeof min === "number" && typeof max === "number" && min >= max) {
    return { valid: false, message: `${key.charAt(0).toUpperCase() + key.slice(1)} min must be less than max` };
  }

  return { valid: true };
}

function hasSettingsChanges(currentSettings: SensorSettings, nextSettings: SensorSettings): boolean {
  return SETTINGS_FIELDS.some((field) => {
    const currentValue = Number(currentSettings[field]);
    const nextValue = Number(nextSettings[field]);
    return !Number.isNaN(currentValue) && !Number.isNaN(nextValue)
      ? currentValue !== nextValue
      : currentSettings[field] !== nextSettings[field];
  });
}

export default function SettingsPage() {
  const {
    settings,
    settingsLoading,
    settingsError,
    saveError,
    saveSettings,
    settingsSaved,
    settingsSaving,
    refetchSettings,
  } = useSensorSettings();
  const { user } = useAuth();
  const logActivity = useActivityLogger();
  const isAdmin = user?.role === "admin";

  const [localSettings, setLocalSettings] = useState<SensorSettings | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  const [users, setUsers] = useState<UserEntry[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [resetModal, setResetModal] = useState<{ id: number; name: string; password: string; errors: FormErrors } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; username: string } | null>(null);
  const [toasts, setToasts] = useState<{ id: number; message: string; type: "success" | "error" }[]>([]);

  const [deletionStep, setDeletionStep] = useState<"request" | "verify" | null>(null);
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionReason, setDeletionReason] = useState("");
  const [deletionOtpCode, setDeletionOtpCode] = useState("");
  const [deletionRequestId, setDeletionRequestId] = useState<number | null>(null);
  const [deletionEmailTo, setDeletionEmailTo] = useState("");

  const showToast = useCallback((message: string, type: "success" | "error") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const [form, setForm] = useState<UserForm>({
    name: "",
    username: "",
    email: "",
    password: "",
    role: "user",
  });

  const displaySettings = useMemo(() => {
    return localSettings ?? settings ?? DEFAULT_SETTINGS;
  }, [localSettings, settings]);

  const updateSetting = useCallback((key: keyof SensorSettings, value: string) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return;

    const validation = validateSetting(key, numValue);
    setValidationErrors((prev) => {
      const next = { ...prev };
      if (validation.valid) {
        delete next[key];
      } else {
        next[key] = validation.message!;
      }
      return next;
    });

    setLocalSettings((prev) => {
      const base = prev ?? settings ?? DEFAULT_SETTINGS;
      return { ...base, [key]: numValue };
    });
  }, [settings]);

  const handleSave = useCallback(async () => {
    if (!localSettings) return;

    setLocalSaveError(null);

    const settingsToValidate = localSettings ?? settings ?? DEFAULT_SETTINGS;
    const rangeValidations = Object.keys(KEY_MAPPING).map((key) =>
      validateRange(key, settingsToValidate)
    );

    const invalidRange = rangeValidations.find((v) => !v.valid);
    if (invalidRange) {
      setLocalSaveError(invalidRange.message!);
      return;
    }

    if (Object.keys(validationErrors).length > 0) {
      setLocalSaveError("Please fix validation errors before saving");
      return;
    }

    if (!hasSettingsChanges(settings ?? DEFAULT_SETTINGS, localSettings)) {
      setLocalSettings(null);
      return;
    }

    try {
      await saveSettings(localSettings);
      refetchSettings();
      logActivity("settings_change", "Updated sensor thresholds", "Settings");
    } catch {
      setLocalSaveError("Failed to save settings");
    }
  }, [localSettings, settings, saveSettings, validationErrors, logActivity, refetchSettings]);

  const handleResetSettings = useCallback(async () => {
    setIsResetting(true);
    setLocalSaveError(null);
    try {
      await apiResetSettings();
      setLocalSettings(null);
      refetchSettings();
      logActivity("settings_change", "Reset sensor thresholds to defaults", "Settings");
      showToast("Settings reset to defaults", "success");
    } catch {
      setLocalSaveError("Failed to reset settings");
    } finally {
      setIsResetting(false);
    }
  }, [logActivity, showToast, refetchSettings]);

  const thresholdConfig = useMemo(
    () => getSettingsThresholds(displaySettings),
    [displaySettings]
  );

  const showError = localSaveError || saveError || settingsError;

  const loadUsers = useCallback(async () => {
    try {
      const data = await fetchUsers();
      setUsers(data);
    } catch {
      showToast("Failed to load users", "error");
    } finally {
      setIsLoadingUsers(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (isAdmin) {
      const loadInitialUsers = async () => {
        try {
          const data = await fetchUsers();
          setUsers(data);
        } catch {
          showToast("Failed to load users", "error");
        } finally {
          setIsLoadingUsers(false);
        }
      };
      void loadInitialUsers();
    }
  }, [isAdmin, showToast]);

  const validateForm = useCallback((): FormErrors => {
    try {
      userSchema.parse(form);
      return {};
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors: FormErrors = {};
        err.issues.forEach((e) => {
          if (e.path[0]) {
            errors[e.path[0] as string] = e.message;
          }
        });
        return errors;
      }
      return { general: "Invalid form data" };
    }
  }, [form]);

  const handleCreateUser = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const errors = validateForm();
    setFormErrors(errors);

    if (Object.keys(errors).length === 0) {
      setActionLoading("create");
      try {
        await createUser(form.name, form.username, form.email, form.password, form.role);
        showToast(`User "${form.username}" created successfully`, "success");
        setForm({ name: "", username: "", email: "", password: "", role: "user" });
        setShowCreateForm(false);
        setFormErrors({});
        await loadUsers();
      } catch (err: unknown) {
        showToast(getApiError(err), "error");
      } finally {
        setActionLoading(null);
      }
    }
  }, [form, validateForm, showToast, loadUsers]);

  const handleRequestDeletion = useCallback(async () => {
    if (!deleteConfirm || !deletionPassword) return;
    setActionLoading(`delete-${deleteConfirm.id}`);
    try {
      const res = await requestUserDeletion(deleteConfirm.id, deletionPassword, deletionReason || undefined);
      setDeletionRequestId(res.request_id);
      setDeletionEmailTo(res.email_to || "");
      setDeletionStep("verify");
      const hint = res.dev_fallback ? " (check server console)" : "";
      const where = res.email_to ? res.email_to : `${deleteConfirm.username}`;
      showToast(`OTP sent to ${where}${hint}`, "success");
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setActionLoading(null);
    }
  }, [deleteConfirm, deletionPassword, deletionReason, showToast]);

  const handleVerifyDeletion = useCallback(async () => {
    if (!deleteConfirm || deletionRequestId === null || !deletionOtpCode) return;
    setActionLoading(`verify-${deleteConfirm.id}`);
    try {
      await verifyUserDeletion(deleteConfirm.id, deletionRequestId, deletionOtpCode);
      showToast("User deleted successfully", "success");
      setDeleteConfirm(null);
      setDeletionStep(null);
      setDeletionPassword("");
      setDeletionReason("");
      setDeletionOtpCode("");
      setDeletionRequestId(null);
      setDeletionEmailTo("");
      await loadUsers();
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setActionLoading(null);
    }
  }, [deleteConfirm, deletionRequestId, deletionOtpCode, showToast, loadUsers]);

  const handleResetPassword = useCallback(async (id: number) => {
    if (!resetModal) return;

    try {
      const { password } = resetModal;
      const pwSchema = z.string().min(8, "Password must be at least 8 characters").max(100)
        .regex(/[A-Z]/, "Must contain an uppercase letter")
        .regex(/[a-z]/, "Must contain a lowercase letter")
        .regex(/[0-9]/, "Must contain a number");
      pwSchema.parse(password);

      setActionLoading(`reset-${id}`);
      await resetUserPassword(id, password);
      showToast("Password reset successfully", "success");
      setResetModal(null);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        const errors: FormErrors = {};
        err.issues.forEach((e) => {
          errors.password = e.message;
        });
        setResetModal((prev) => prev ? { ...prev, errors } : null);
      } else if (err instanceof Error && err.message) {
        showToast(err.message, "error");
      } else {
        showToast("Failed to reset password", "error");
      }
    } finally {
      setActionLoading(null);
    }
  }, [resetModal, showToast]);

  const [recipients, setRecipients] = useState<SmsRecipient[]>([]);
  const [isLoadingRecipients, setIsLoadingRecipients] = useState(true);
  const [newRecipientName, setNewRecipientName] = useState("");
  const [newRecipientPhone, setNewRecipientPhone] = useState("");
  const [recipientErrors, setRecipientErrors] = useState<Record<string, string>>({});
  const [editingName, setEditingName] = useState<{ id: number; value: string; original: string } | null>(null);
  const [smsMuteStatus, setSmsMuteStatus] = useState<MuteStatus | null>(null);
  const [muteHours, setMuteHours] = useState(1);
  const [smsActionLoading, setSmsActionLoading] = useState<string | null>(null);
  const [smsLogsOpen, setSmsLogsOpen] = useState(false);
  const [smsLogs, setSmsLogs] = useState<SmsLogEntry[]>([]);
  const [smsLogsLoading, setSmsLogsLoading] = useState(false);
  const [smsLogsTotal, setSmsLogsTotal] = useState(0);
  const [smsLogsPage, setSmsLogsPage] = useState(1);
  const [smsLogsPageSize] = useState(10);
  const [smsLogsFilter, setSmsLogsFilter] = useState("");
  const [smsHealth, setSmsHealth] = useState<SmsHealth | null>(null);

  const refreshSmsHealth = useCallback(async () => {
    try {
      setSmsHealth(await fetchSmsHealth());
    } catch {
      // health banner stays hidden when the endpoint is unavailable
    }
  }, []);

  const loadSmsLogs = useCallback(
    async (page: number, status: string) => {
      setSmsLogsLoading(true);
      try {
        const data = await fetchSmsLogs({ page, pageSize: smsLogsPageSize, status: status || undefined });
        setSmsLogs(data.rows);
        setSmsLogsTotal(data.total);
        setSmsLogsPage(data.page);
      } catch {
        setSmsLogs([]);
        setSmsLogsTotal(0);
      } finally {
        setSmsLogsLoading(false);
      }
    },
    [smsLogsPageSize]
  );

  const openSmsLogs = useCallback(() => {
    setSmsLogsOpen(true);
    setSmsLogsFilter("");
    setSmsLogsPage(1);
    void loadSmsLogs(1, "");
    void refreshSmsHealth();
  }, [loadSmsLogs, refreshSmsHealth]);

  const closeSmsLogs = useCallback(() => setSmsLogsOpen(false), []);

  const applySmsLogFilter = useCallback(
    (status: string) => {
      setSmsLogsFilter(status);
      setSmsLogsPage(1);
      void loadSmsLogs(1, status);
    },
    [loadSmsLogs]
  );

  const goSmsLogPage = useCallback(
    (page: number) => {
      const maxPage = Math.max(1, Math.ceil(smsLogsTotal / smsLogsPageSize));
      const next = Math.min(Math.max(1, page), maxPage);
      setSmsLogsPage(next);
      void loadSmsLogs(next, smsLogsFilter);
    },
    [loadSmsLogs, smsLogsTotal, smsLogsPageSize, smsLogsFilter]
  );

  const loadSmsSettings = useCallback(async () => {
    try {
      const [recipientData, muteData] = await Promise.all([fetchSmsRecipients(), fetchSmsMuteStatus()]);
      setRecipients(recipientData);
      setSmsMuteStatus(muteData);
    } catch {
      showToast("Failed to load SMS settings", "error");
    } finally {
      setIsLoadingRecipients(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (isAdmin) {
      const loadInitialSms = async () => {
        try {
          const [recipientData, muteData] = await Promise.all([fetchSmsRecipients(), fetchSmsMuteStatus()]);
          setRecipients(recipientData);
          setSmsMuteStatus(muteData);
        } catch {
          showToast("Failed to load SMS settings", "error");
        } finally {
          setIsLoadingRecipients(false);
        }
        try {
          setSmsHealth(await fetchSmsHealth());
        } catch {
          // health banner stays hidden when the endpoint is unavailable
        }
      };
      void loadInitialSms();
    }
  }, [isAdmin, showToast]);

  const handleAddRecipient = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const phone = newRecipientPhone.trim().replace(/[\s\-()]/g, "");
    const errors: Record<string, string> = {};
    if (!/^09\d{9}$/.test(phone) && !/^\+639\d{9}$/.test(phone)) {
      errors.phone = "Enter a valid PH mobile number: 09XXXXXXXXX or +639XXXXXXXXX";
    }
    if (!newRecipientName.trim()) errors.name = "Name is required";
    setRecipientErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSmsActionLoading("add");
    try {
      await addSmsRecipient({ phone_number: phone, name: newRecipientName.trim() });
      showToast("SMS recipient added", "success");
      setNewRecipientName("");
      setNewRecipientPhone("");
      setRecipientErrors({});
      await loadSmsSettings();
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setSmsActionLoading(null);
    }
  }, [newRecipientName, newRecipientPhone, showToast, loadSmsSettings]);

  const handleToggleRecipient = useCallback(async (r: SmsRecipient) => {
    setSmsActionLoading(`toggle-${r.id}`);
    try {
      await updateSmsRecipient(r.id, { is_active: !r.is_active });
      await loadSmsSettings();
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setSmsActionLoading(null);
    }
  }, [loadSmsSettings, showToast]);

  const handleSaveRecipientName = useCallback(async () => {
    if (!editingName) return;
    setSmsActionLoading(`rename-${editingName.id}`);
    try {
      await updateSmsRecipient(editingName.id, { name: editingName.value.trim() || editingName.original });
      setEditingName(null);
      await loadSmsSettings();
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setSmsActionLoading(null);
    }
  }, [editingName, loadSmsSettings, showToast]);

  const handleSendTest = useCallback(async (r: SmsRecipient) => {
    setSmsActionLoading(`test-${r.id}`);
    try {
      const res = await sendTestSms(r.id);
      showToast(res.message || "Test SMS sent", "success");
      void refreshSmsHealth();
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setSmsActionLoading(null);
    }
  }, [showToast, refreshSmsHealth]);

  const handleDeleteRecipient = useCallback(async (r: SmsRecipient) => {
    setSmsActionLoading(`del-${r.id}`);
    try {
      await deleteSmsRecipient(r.id);
      showToast("SMS recipient removed", "success");
      await loadSmsSettings();
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setSmsActionLoading(null);
    }
  }, [loadSmsSettings, showToast]);

  const handleSendStatusNow = useCallback(async () => {
    setSmsActionLoading("status");
    try {
      const { sent, total } = await sendStatusSms();
      showToast(`Status SMS sent to ${sent}/${total} recipient(s)`, "success");
      void refreshSmsHealth();
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setSmsActionLoading(null);
    }
  }, [showToast, refreshSmsHealth]);

  const handleToggleMute = useCallback(async () => {
    const currentlyMuted = Boolean(smsMuteStatus?.muted);
    setSmsActionLoading("mute");
    try {
      const status = await setSmsMute(currentlyMuted ? 0 : (muteHours || 1));
      setSmsMuteStatus(status);
      showToast(currentlyMuted ? "SMS alerts unmuted" : `SMS alerts muted for ${muteHours || 1} hour(s)`, "success");
    } catch (err: unknown) {
      showToast(getApiError(err), "error");
    } finally {
      setSmsActionLoading(null);
    }
  }, [smsMuteStatus, muteHours, showToast]);

  // Whether local edits differ from what is saved on the server.
  const dirty =
    localSettings != null && hasSettingsChanges(settings ?? DEFAULT_SETTINGS, localSettings);

  const adminCount = useMemo(() => users.filter((u) => u.role === "admin").length, [users]);

  // Only block on first load; keep form visible during background refetch after save/reset.
  if (settingsLoading && !settings) {
    return <LoadingCard title="Settings" message="Loading settings..." />;
  }

  return (
    <div className="space-y-6">
      {showError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
          {localSaveError || saveError || settingsError}
        </div>
      )}

      {/* Hero banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#d94b1e] via-[#ef6a2e] to-amber-600 text-white shadow-sm">
        <div className="relative p-6 lg:p-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center shrink-0">
              <Settings size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                Settings
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-white/20 border border-white/30">
                  {isAdmin ? <Shield size={12} /> : <Lock size={12} />}
                  {user?.owner ? "Owner" : isAdmin ? "Administrator" : "View Only"}
                </span>
              </h1>
              <p className="text-white/80 text-sm mt-1">
                {isAdmin
                  ? "Configure sensor thresholds and manage system accounts"
                  : "View sensor thresholds — only administrators can modify these settings"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={refetchSettings}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-[#c2410c] text-sm font-semibold hover:bg-orange-50 transition"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>
        <div className="px-6 lg:px-7 pb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/85">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">3 alert parameters</span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">6 thresholds</span>
          {isAdmin && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
              {users.length} user{users.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </section>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <SlidersHorizontal size={12} /> Alert Parameters
          </div>
          <div className="text-2xl font-bold text-gray-800 mt-1">3</div>
          <div className="text-[10px] text-gray-400">temperature, water, ammonia</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <SlidersHorizontal size={12} className="text-orange-500" /> Thresholds
          </div>
          <div className="text-2xl font-bold text-orange-600 mt-1">6</div>
          <div className="text-[10px] text-gray-400">min/max per parameter</div>
        </div>
        {isAdmin ? (
          <>
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <Users size={12} className="text-orange-500" /> User Accounts
              </div>
              <div className="text-2xl font-bold text-orange-600 mt-1">{users.length}</div>
              <div className="text-[10px] text-gray-400">on the system</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <Shield size={12} className="text-amber-500" /> Admins
              </div>
              <div className="text-2xl font-bold text-amber-600 mt-1">{adminCount}</div>
              <div className="text-[10px] text-gray-400">administrator accounts</div>
            </div>
          </>
        ) : (
          <>
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <Lock size={12} className="text-gray-500" /> Access
              </div>
              <div className="text-2xl font-bold text-gray-800 mt-1">View</div>
              <div className="text-[10px] text-gray-400">read-only access</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <AlertTriangle size={12} className="text-amber-500" /> Alerts Active
              </div>
              <div className="text-2xl font-bold text-amber-600 mt-1">Yes</div>
              <div className="text-[10px] text-gray-400">thresholds enforced</div>
            </div>
          </>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="text-orange-600" size={18} />
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
            Alert Thresholds
          </div>
          {dirty && isAdmin && (
            <span className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Unsaved changes
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Alerts are logged when a sensor value falls outside the green safe band.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(Object.keys(KEY_MAPPING) as Array<keyof typeof KEY_MAPPING>).map((key) => {
            const threshold = thresholdConfig[key];
            const keys = KEY_MAPPING[key];
            const colors = THRESHOLD_COLORS[key];
            const meta = THRESHOLD_META[key];
            const ParamIcon = meta.icon;
            const bounds = SETTING_BOUNDS[keys.min] ?? { min: 0, max: 100 };
            const minVal = Number(displaySettings[keys.min]);
            const maxVal = Number(displaySettings[keys.max]);
            const rangeInvalid = minVal >= maxVal;

            return (
              <div
                key={key}
                className={`rounded-xl p-4 border ${colors.bg} ${colors.border} space-y-3`}
              >
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 rounded-lg bg-white border border-gray-200 flex items-center justify-center shrink-0">
                    <ParamIcon size={15} className={meta.tint} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold uppercase text-gray-700 leading-tight">
                      {threshold.name}
                      <span className="font-normal text-gray-500 ml-1">({threshold.unit})</span>
                    </div>
                    <div className="text-[10px] text-gray-400">Alerting safe range</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Min</label>
                    <input
                      type="number"
                      step="0.1"
                      disabled={!isAdmin}
                      value={displaySettings[keys.min] != null ? Number(displaySettings[keys.min]) : threshold.range.min}
                      onChange={(e) => updateSetting(keys.min, e.target.value)}
                      className={`w-full px-2 py-1.5 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent ${
                        !isAdmin
                          ? "bg-gray-100 text-gray-500 cursor-not-allowed border-gray-200"
                          : validationErrors[keys.min]
                          ? "border-red-500"
                          : "border-gray-200"
                      }`}
                    />
                    {validationErrors[keys.min] && isAdmin && (
                      <div className="text-[10px] text-red-500 mt-1">
                        {validationErrors[keys.min]}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Max</label>
                    <input
                      type="number"
                      step="0.1"
                      disabled={!isAdmin}
                      value={displaySettings[keys.max] != null ? Number(displaySettings[keys.max]) : threshold.range.max}
                      onChange={(e) => updateSetting(keys.max, e.target.value)}
                      className={`w-full px-2 py-1.5 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent ${
                        !isAdmin
                          ? "bg-gray-100 text-gray-500 cursor-not-allowed border-gray-200"
                          : validationErrors[keys.max]
                          ? "border-red-500"
                          : "border-gray-200"
                      }`}
                    />
                  </div>
                </div>
                <RangeTrack
                  min={minVal}
                  max={maxVal}
                  bounds={bounds}
                  invalid={rangeInvalid}
                />
                <div className="text-[10px] text-gray-400">
                  Permitted bounds: {bounds.min} to {bounds.max} {threshold.unit}
                  {rangeInvalid && (
                    <span className="ml-1 text-red-500 font-semibold">min must be less than max</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {isAdmin ? (
          <>
            <button
              onClick={handleSave}
              disabled={settingsSaving || Object.keys(validationErrors).length > 0}
              className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-400 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Save size={16} />
              {settingsSaving ? "Saving..." : "Save Settings"}
            </button>
            <button
              onClick={handleResetSettings}
              disabled={isResetting}
              className="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <RefreshCw size={16} className={isResetting ? "animate-spin" : ""} />
              {isResetting ? "Resetting..." : "Reset to Defaults"}
            </button>
          </>
        ) : (
          <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-400 rounded-lg text-sm font-medium cursor-not-allowed">
            <Lock size={16} />
            Admin Access Required
          </div>
        )}
        {settingsSaved && isAdmin && (
          <span className="text-sm text-green-600 font-medium">Settings saved!</span>
        )}
      </div>

      {isAdmin && (
        <div className="space-y-6 pt-6 border-t border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <Users size={20} className="text-orange-500" />
                User Management
                <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                  {users.length} account{users.length === 1 ? "" : "s"}
                </span>
              </h2>
              <p className="text-sm text-gray-500">Manage system accounts and access control</p>
            </div>
            {!showCreateForm && (
              <button
                onClick={() => setShowCreateForm(true)}
                className="flex items-center gap-2 bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white px-4 py-2 rounded-lg font-semibold text-sm hover:from-[#c2410c] hover:to-[#d94b1e] transition-all"
              >
                <UserPlus size={16} />
                Add User
              </button>
            )}
          </div>

          {showCreateForm && (
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-md font-bold text-gray-800">Create New Account</h3>
                <button
                  onClick={() => {
                    setShowCreateForm(false);
                    setFormErrors({});
                    setForm({ name: "", username: "", email: "", password: "", role: "user" });
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X size={20} />
                </button>
              </div>

              <form onSubmit={handleCreateUser} className="space-y-4" noValidate>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="user-name" className="block text-sm font-medium text-gray-700 mb-1">
                      Full Name
                    </label>
                    <input
                      id="user-name"
                      type="text"
                      value={form.name}
                      onChange={(e) => {
                        setForm((prev) => ({ ...prev, name: e.target.value }));
                        if (formErrors.name) setFormErrors((prev) => ({ ...prev, name: "" }));
                      }}
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] ${
                        formErrors.name ? "border-red-500 bg-red-50" : "border-gray-300"
                      }`}
                      placeholder="John Doe"
                    />
                    {formErrors.name && <p className="mt-1 text-xs text-red-600">{formErrors.name}</p>}
                  </div>

                  <div>
                    <label htmlFor="user-username" className="block text-sm font-medium text-gray-700 mb-1">
                      Username
                    </label>
                    <input
                      id="user-username"
                      type="text"
                      value={form.username}
                      onChange={(e) => {
                        setForm((prev) => ({ ...prev, username: e.target.value }));
                        if (formErrors.username) setFormErrors((prev) => ({ ...prev, username: "" }));
                      }}
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] ${
                        formErrors.username ? "border-red-500 bg-red-50" : "border-gray-300"
                      }`}
                      placeholder="john_doe"
                    />
                    {formErrors.username && <p className="mt-1 text-xs text-red-600">{formErrors.username}</p>}
                  </div>

                  <div>
                    <label htmlFor="user-email" className="block text-sm font-medium text-gray-700 mb-1">
                      Email
                    </label>
                    <input
                      id="user-email"
                      type="email"
                      value={form.email}
                      onChange={(e) => {
                        setForm((prev) => ({ ...prev, email: e.target.value }));
                        if (formErrors.email) setFormErrors((prev) => ({ ...prev, email: "" }));
                      }}
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] ${
                        formErrors.email ? "border-red-500 bg-red-50" : "border-gray-300"
                      }`}
                      placeholder="john@example.com"
                    />
                    {formErrors.email && <p className="mt-1 text-xs text-red-600">{formErrors.email}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Role
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, role: "user" }))}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 border-2 rounded-lg text-sm font-semibold transition-all ${
                          form.role === "user"
                            ? "border-[#d94b1e] bg-[#d94b1e]/5 text-[#d94b1e]"
                            : "border-gray-200 text-gray-500 hover:border-gray-300"
                        }`}
                      >
                        <User size={14} />
                        User
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, role: "admin" }))}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 border-2 rounded-lg text-sm font-semibold transition-all ${
                          form.role === "admin"
                            ? "border-[#d94b1e] bg-[#d94b1e]/5 text-[#d94b1e]"
                            : "border-gray-200 text-gray-500 hover:border-gray-300"
                        }`}
                      >
                        <Shield size={14} />
                        Admin
                      </button>
                    </div>
                  </div>

                  <div className="md:col-span-2">
                    <label htmlFor="user-password" className="block text-sm font-medium text-gray-700 mb-1">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        id="user-password"
                        type={showPassword ? "text" : "password"}
                        value={form.password}
                        onChange={(e) => {
                          setForm((prev) => ({ ...prev, password: e.target.value }));
                          if (formErrors.password) setFormErrors((prev) => ({ ...prev, password: "" }));
                        }}
                        className={`w-full px-3 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] ${
                          formErrors.password ? "border-red-500 bg-red-50" : "border-gray-300"
                        }`}
                        placeholder="Create a secure password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    {formErrors.password && <p className="mt-1 text-xs text-red-600">{formErrors.password}</p>}
                    <div className="mt-2 grid grid-cols-2 gap-1">
                      <p className={`text-xs ${/[A-Z]/.test(form.password) ? "text-green-600" : "text-gray-400"}`}>
                        {/[A-Z]/.test(form.password) ? "✓" : "○"} Uppercase
                      </p>
                      <p className={`text-xs ${/[a-z]/.test(form.password) ? "text-green-600" : "text-gray-400"}`}>
                        {/[a-z]/.test(form.password) ? "✓" : "○"} Lowercase
                      </p>
                      <p className={`text-xs ${/[0-9]/.test(form.password) ? "text-green-600" : "text-gray-400"}`}>
                        {/[0-9]/.test(form.password) ? "✓" : "○"} Number
                      </p>
                      <p className={`text-xs ${form.password.length >= 8 ? "text-green-600" : "text-gray-400"}`}>
                        {form.password.length >= 8 ? "✓" : "○"} 8+ chars
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2 justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateForm(false);
                      setFormErrors({});
                      setForm({ name: "", username: "", email: "", password: "", role: "user" });
                    }}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={actionLoading === "create"}
                    className="flex items-center gap-2 bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white px-6 py-2 rounded-lg font-semibold text-sm hover:from-[#c2410c] hover:to-[#d94b1e] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {actionLoading === "create" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <UserPlus size={16} />
                    )}
                    Create Account
                  </button>
                </div>
              </form>
            </div>
          )}

          {isLoadingUsers ? (
            <div className="bg-white rounded-lg shadow p-8 text-center">
              <Loader2 size={32} className="animate-spin mx-auto text-gray-400" />
              <p className="text-sm text-gray-500 mt-2">Loading users...</p>
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">User</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Username</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Role</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Created</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {users.map((u) => (
                      <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="w-8 h-8 rounded-full bg-gray-100 border border-gray-200 text-gray-600 text-xs font-bold flex items-center justify-center shrink-0">
                              {(u.name || u.username).charAt(0).toUpperCase()}
                            </span>
                            <div>
                              <p className="font-medium text-gray-800 text-sm">{u.name}</p>
                              <p className="text-xs text-gray-500">{u.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-mono">{u.username}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                            u.owner || u.role === "admin"
                              ? "bg-orange-100 text-orange-800"
                              : "bg-amber-100 text-amber-700"
                          }`}>
                            {u.owner || u.role === "admin" ? <Shield size={12} /> : <User size={12} />}
                            {u.owner ? "Owner" : u.role.charAt(0).toUpperCase() + u.role.slice(1)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {formatFarmDate(u.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => setResetModal({ id: u.id, name: u.username, password: "", errors: {} })}
                              className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-md transition-colors"
                              title="Reset Password"
                            >
                              <KeyRound size={16} />
                            </button>
                            {user?.id !== u.id && (
                              <button
                                onClick={() => setDeleteConfirm({ id: u.id, username: u.username })}
                                className={
                                  u.protected
                                    ? "p-1.5 text-gray-300 cursor-not-allowed rounded-md"
                                    : "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                }
                                title={u.protected ? "This account is protected and cannot be deleted" : "Delete User"}
                                disabled={u.protected}
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                          No users found. Click "Add User" to create one.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="space-y-4 border-t border-gray-100 pt-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2 flex-wrap">
                  <MessageSquare size={20} className="text-orange-500" />
                  SMS Alerts
                  <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                    {recipients.filter((r) => r.is_active).length}/{recipients.length} active
                  </span>
                  {smsHealth && (
                    <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                      {smsHealth.smsCap > 0 ? `${smsHealth.smsToday}/${smsHealth.smsCap} today` : `${smsHealth.smsToday} sent today`}
                    </span>
                  )}
                </h3>
                <p className="text-sm text-gray-500">Critical alerts, hourly status, and disconnect warnings sent via HTTPSMS</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={openSmsLogs}
                  className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-50 transition"
                  title="View SMS delivery history"
                >
                  <ScrollText size={14} />
                  SMS Logs
                </button>
                <button
                  onClick={handleSendStatusNow}
                  disabled={smsActionLoading === "status" || Boolean(smsMuteStatus?.muted)}
                  title={smsMuteStatus?.muted ? "SMS alerts are muted" : "Send the status update SMS immediately"}
                  className="flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 text-orange-700 rounded-lg text-sm font-semibold hover:bg-orange-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send size={14} className={smsActionLoading === "status" ? "animate-spin" : ""} />
                  {smsActionLoading === "status" ? "Sending..." : "Send Status SMS Now"}
                </button>
              </div>
            </div>

            {smsHealth?.degraded && (
              <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm">
                <AlertTriangle size={16} className="text-amber-600 shrink-0" />
                <span>
                  SMS service degraded: {smsHealth.last24h.failed} failed send(s)
                  {smsHealth.last24h.stuckQueued > 0 ? ` and ${smsHealth.last24h.stuckQueued} stuck queued` : ""} in the last 24h. Check the gateway phone's connection.
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 text-sm bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <label className="flex items-center gap-2 text-gray-600">
                <Bell size={14} className="text-orange-500" />
                Mute all SMS for
                <input
                  type="number"
                  min={1}
                  max={48}
                  value={muteHours}
                  onChange={(e) => setMuteHours(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-16 px-2 py-1 border border-gray-300 rounded-lg text-center focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
                />
                hour(s)
              </label>
              <button
                onClick={handleToggleMute}
                disabled={smsActionLoading === "mute"}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition disabled:opacity-50 ${
                  smsMuteStatus?.muted
                    ? "bg-gray-600 text-white hover:bg-gray-700"
                    : "bg-red-600 text-white hover:bg-red-700"
                }`}
              >
                {smsActionLoading === "mute" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <BellOff size={14} />
                )}
                {smsMuteStatus?.muted ? "Unmute SMS" : "Mute SMS"}
              </button>
              {smsMuteStatus?.muted && smsMuteStatus.muteExpires && (
                <span className="text-xs font-medium text-red-600">
                  Muted until {formatFarmDate(smsMuteStatus.muteExpires)}
                </span>
              )}
            </div>

            <form onSubmit={handleAddRecipient} noValidate className="bg-amber-50/60 border border-amber-100 rounded-xl p-4 space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <input
                    type="text"
                    value={newRecipientName}
                    onChange={(e) => {
                      setNewRecipientName(e.target.value);
                      if (recipientErrors.name) setRecipientErrors((prev) => ({ ...prev, name: "" }));
                    }}
                    className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 ${
                      recipientErrors.name ? "border-red-500 bg-red-50" : "border-gray-300"
                    }`}
                    placeholder="Recipient name (e.g. Farm Manager)"
                  />
                  {recipientErrors.name && <p className="mt-1 text-xs text-red-600">{recipientErrors.name}</p>}
                </div>
                <div className="flex-1">
                  <input
                    type="tel"
                    value={newRecipientPhone}
                    onChange={(e) => {
                      setNewRecipientPhone(e.target.value.replace(/[^\d+]/g, "").slice(0, 13));
                      if (recipientErrors.phone) setRecipientErrors((prev) => ({ ...prev, phone: "" }));
                    }}
                    className={`w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 ${
                      recipientErrors.phone ? "border-red-500 bg-red-50" : "border-gray-300"
                    }`}
                    placeholder="09XXXXXXXXX (PH number)"
                  />
                  {recipientErrors.phone && <p className="mt-1 text-xs text-red-600">{recipientErrors.phone}</p>}
                </div>
                <button
                  type="submit"
                  disabled={smsActionLoading === "add"}
                  className="flex items-center justify-center gap-2 bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white px-5 py-2 rounded-lg font-semibold text-sm hover:from-[#c2410c] hover:to-[#d94b1e] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {smsActionLoading === "add" ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
                  Add Recipient
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Requires an Android gateway running the HttpSms app with the SIM whose number is set as <span className="font-mono">HTTPSMS_FROM</span>. Recipients receive critical alerts, the hourly status update, and device-disconnect warnings.
              </p>
            </form>

            {isLoadingRecipients ? (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
                <Loader2 size={32} className="animate-spin mx-auto text-gray-400" />
                <p className="text-sm text-gray-500 mt-2">Loading SMS recipients...</p>
              </div>
            ) : recipients.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
                <MessageSquare size={32} className="mx-auto text-gray-300" />
                <p className="text-sm text-gray-500 mt-2">
                  No SMS recipients yet. Add a Philippine mobile number above to start receiving alerts.
                </p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Name</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Phone Number</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {recipients.map((r) => (
                        <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3">
                            {editingName?.id === r.id ? (
                              <div className="flex items-center gap-2">
                                <input
                                  autoFocus
                                  value={editingName.value}
                                  onChange={(e) => setEditingName({ ...editingName, value: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveRecipientName(); if (e.key === "Escape") setEditingName(null); }}
                                  className="w-full max-w-xs px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
                                />
                                <button
                                  onClick={handleSaveRecipientName}
                                  disabled={smsActionLoading === `rename-${r.id}`}
                                  className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors"
                                  title="Save name"
                                >
                                  <Check size={16} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-gray-800">{r.name || "—"}</span>
                                <button
                                  onClick={() => setEditingName({ id: r.id, value: r.name || "", original: r.name || "" })}
                                  className="p-1 text-gray-300 hover:text-orange-600 hover:bg-orange-50 rounded-md transition-colors"
                                  title="Rename"
                                >
                                  <Pencil size={13} />
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 font-mono">{r.phone_number}</td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => handleToggleRecipient(r)}
                              disabled={smsActionLoading === `toggle-${r.id}`}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition ${
                                r.is_active
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                                  : "bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200"
                              }`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${r.is_active ? "bg-emerald-500" : "bg-gray-400"}`} />
                              {r.is_active ? "Active" : "Paused"}
                            </button>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => handleSendTest(r)}
                                disabled={smsActionLoading === `test-${r.id}`}
                                className="p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-md transition-colors"
                                title="Send test SMS"
                              >
                                {smsActionLoading === `test-${r.id}` ? (
                                  <Loader2 size={16} className="animate-spin" />
                                ) : (
                                  <Send size={16} />
                                )}
                              </button>
                              <button
                                onClick={() => handleDeleteRecipient(r)}
                                disabled={smsActionLoading === `del-${r.id}`}
                                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                title="Remove recipient"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {smsLogsOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={closeSmsLogs}>
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-100">
              <div>
                <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                  <ScrollText size={20} className="text-orange-500" />
                  SMS Logs
                </h3>
                <p className="text-sm text-gray-500">
                  {smsHealth
                    ? smsHealth.smsCap > 0
                      ? `${smsHealth.smsToday}/${smsHealth.smsCap} SMS today`
                      : `${smsHealth.smsToday} SMS today`
                    : "Delivery history"}
                  {" · "}
                  {smsLogsTotal} recorded
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void loadSmsLogs(smsLogsPage, smsLogsFilter)}
                  className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Refresh"
                >
                  <RefreshCw size={16} className={smsLogsLoading ? "animate-spin" : ""} />
                </button>
                <button onClick={closeSmsLogs} className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors" title="Close">
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-gray-100">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Status</span>
              <div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-gray-100 p-1">
                {[
                  { value: "", label: "All" },
                  { value: "delivered", label: "Delivered" },
                  { value: "queued", label: "Queued" },
                  { value: "sent", label: "Sent" },
                  { value: "failed", label: "Failed" },
                  { value: "capped", label: "Capped" },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => applySmsLogFilter(value)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                      smsLogsFilter === value ? "bg-white text-orange-700 shadow-sm ring-1 ring-gray-200" : "text-gray-500 hover:text-gray-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto min-h-[200px]">
              {smsLogsLoading ? (
                <div className="p-10 text-center">
                  <Loader2 size={28} className="animate-spin mx-auto text-gray-400" />
                </div>
              ) : smsLogs.length === 0 ? (
                <div className="p-10 text-center">
                  <ScrollText size={28} className="mx-auto text-gray-300" />
                  <p className="text-sm text-gray-500 mt-2">
                    No SMS records{smsLogsFilter ? ` with status "${smsLogsFilter}"` : ""} yet.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Status</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Recipient</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Message</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Sent / Delivered</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {smsLogs.map((log) => {
                        const badge = SMS_STATUS_BADGES[log.status] ?? SMS_STATUS_BADGES.sent;
                        return (
                          <tr key={log.id} className="hover:bg-gray-50">
                            <td className="px-4 py-2">
                              <span
                                title={badge.hint}
                                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${badge.cls}`}
                              >
                                {badge.dot && <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />}
                                {badge.label}
                              </span>
                              {log.failure_reason && (
                                <p className="text-[11px] text-red-600 mt-1 max-w-[190px] truncate" title={log.failure_reason}>
                                  {log.failure_reason}
                                </p>
                              )}
                              {log.status === "queued" && <p className="text-[11px] text-gray-400 mt-0.5">waiting for delivery...</p>}
                            </td>
                            <td className="px-4 py-2 text-gray-700 font-mono text-xs whitespace-nowrap">{formatDisplayPhone(log.recipient_phone)}</td>
                            <td className="px-4 py-2 text-gray-600 max-w-[280px]">
                              <p className="truncate" title={log.message}>{log.message}</p>
                            </td>
                            <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                              <p>
                                <span className="text-gray-400">Sent:</span> {formatFarmDateTime(log.sent_at)}
                              </p>
                              <p className="mt-0.5">
                                <span className="text-gray-400">Delivered:</span>{" "}
                                {log.delivered_at ? formatFarmDateTime(log.delivered_at) : "—"}
                              </p>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm">
              <span className="text-xs text-gray-500">
                Page {Math.min(smsLogsPage, Math.max(1, Math.ceil(smsLogsTotal / smsLogsPageSize)))} of{" "}
                {Math.max(1, Math.ceil(smsLogsTotal / smsLogsPageSize))}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => goSmsLogPage(smsLogsPage - 1)}
                  disabled={smsLogsPage <= 1}
                  className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-40 transition-colors"
                  title="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={() => goSmsLogPage(smsLogsPage + 1)}
                  disabled={smsLogsPage >= Math.max(1, Math.ceil(smsLogsTotal / smsLogsPageSize))}
                  className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-40 transition-colors"
                  title="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {resetModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setResetModal(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-1">Reset Password</h3>
            <p className="text-sm text-gray-500 mb-4">Enter new password for <span className="font-semibold">{resetModal.name}</span></p>

            <div className="mb-4">
              <input
                type="password"
                value={resetModal.password}
                onChange={(e) => setResetModal((prev) => prev ? { ...prev, password: e.target.value, errors: {} } : null)}
                className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] ${
                  resetModal.errors.password ? "border-red-500 bg-red-50" : "border-gray-300"
                }`}
                placeholder="New password"
                autoFocus
              />
              {resetModal.errors.password && (
                <p className="mt-1 text-xs text-red-600">{resetModal.errors.password}</p>
              )}
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setResetModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleResetPassword(resetModal.id)}
                disabled={actionLoading === `reset-${resetModal.id}`}
                className="flex items-center gap-2 bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:from-[#c2410c] hover:to-[#d94b1e] disabled:opacity-50"
              >
                {actionLoading === `reset-${resetModal.id}` ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => { setDeleteConfirm(null); setDeletionStep(null); setDeletionPassword(""); setDeletionReason(""); setDeletionOtpCode(""); setDeletionRequestId(null); setDeletionEmailTo(""); }}>
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="text-red-600" size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-800">
                  {deletionStep === "verify" ? "Verify Deletion" : "Delete User"}
                </h3>
                <p className="text-sm text-gray-500">
                  {deletionStep === "verify" ? "Enter the emailed OTP code" : "This action requires email verification"}
                </p>
              </div>
            </div>

            {deletionStep === "verify" ? (
              <div className="mb-6">
                <p className="text-sm text-gray-600 mb-3">
                  An OTP code was sent to{" "}
                  <span className="font-semibold">{deletionEmailTo || `${deleteConfirm.username}`}</span>.
                  Enter the 6-digit code below.
                </p>
                <input
                  type="text"
                  value={deletionOtpCode}
                  onChange={(e) => setDeletionOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-center text-lg font-mono tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
                  placeholder="000000"
                  maxLength={6}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleVerifyDeletion(); }}
                />
              </div>
            ) : (
              <div className="mb-6 space-y-3">
                <p className="text-sm text-gray-600">
                  Are you sure you want to delete the account <span className="font-semibold">{deleteConfirm.username}</span>?
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Your Password <span className="text-gray-400">(logged in as {user?.username})</span>
                  </label>
                  <input
                    type="password"
                    value={deletionPassword}
                    onChange={(e) => setDeletionPassword(e.target.value.trim())}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
                    placeholder={`Enter the password for "${user?.username}"`}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") handleRequestDeletion(); }}
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    This is the password of your own account — not the target user's password.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reason <span className="text-gray-400">(optional)</span></label>
                  <input
                    type="text"
                    value={deletionReason}
                    onChange={(e) => setDeletionReason(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
                    placeholder="Why is this account being deleted?"
                  />
                </div>
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
onClick={() => { setDeleteConfirm(null); setDeletionStep(null); setDeletionPassword(""); setDeletionReason(""); setDeletionOtpCode(""); setDeletionRequestId(null); setDeletionEmailTo(""); }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              {deletionStep === "verify" ? (
                <button
                  onClick={handleVerifyDeletion}
                  disabled={actionLoading === `verify-${deleteConfirm.id}` || deletionOtpCode.length !== 6}
                  className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
                >
                  {actionLoading === `verify-${deleteConfirm.id}` ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                  Verify & Delete
                </button>
              ) : (
                <button
                  onClick={handleRequestDeletion}
                  disabled={actionLoading === `delete-${deleteConfirm.id}` || !deletionPassword}
                  className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
                >
                  {actionLoading === `delete-${deleteConfirm.id}` ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                  Request Deletion
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-center gap-3 p-3 rounded-lg shadow-lg border transition-all animate-slide-in ${
              toast.type === "success"
                ? "bg-green-50 border-green-200 text-green-800"
                : "bg-red-50 border-red-200 text-red-800"
            }`}
          >
            {toast.type === "success" ? (
              <CheckCircle2 size={18} className="text-green-600 shrink-0" />
            ) : (
              <AlertTriangle size={18} className="text-red-600 shrink-0" />
            )}
            <p className="text-sm font-medium flex-1">{toast.message}</p>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="text-gray-400 hover:text-gray-600 shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
