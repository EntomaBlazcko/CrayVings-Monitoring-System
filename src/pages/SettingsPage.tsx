// =============================================================================
// FILE: src/pages/SettingsPage.tsx
// =============================================================================
// PURPOSE: Comprehensive settings and administration page.
//
// This is the largest page in the application. It manages:
//
// 1. ALERT THRESHOLDS (all users view, admin users edit):
//    - Min/Max inputs for Temperature, Water Level, and Ammonia
//    - Validation (bounds checking, min < max enforcement)
//    - Save and Reset to Defaults buttons
//    - Non-admin users see read-only fields with lock icon
//
// 2. SMS RECIPIENTS (admin only):
//    - Add new recipients with name and Philippine phone number (+639XXXXXXXXX)
//    - Toggle recipients active/inactive
//    - Send test SMS to verify delivery
//    - Delete recipients with confirmation modal
//
// 3. SMS ALERT MUTE/SLEEP (admin only):
//    - Mute SMS alerts for 1h, 2h, 4h, 6h, 8h, 12h, or 24h
//    - Unmute button when alerts are muted
//    - Status display showing when mute expires
//
// 4. USER MANAGEMENT (admin only):
//    - Create new user accounts with Zod-validated form
//    - Password strength requirements (uppercase, lowercase, number, 8+ chars)
//    - Role assignment (user or admin)
//    - Reset user passwords via modal dialog
//    - Delete user accounts with confirmation modal
//    - Cannot delete own account
//
// 5. DEFAULT ADMIN CREDENTIALS DISPLAY:
//    - Shows admin/Admin@123 reminder for first-time setup
//
// VALIDATION:
//    - Zod schema for user creation form
//    - Manual validation for settings bounds and range checks
//    - Real-time error display on form fields
// =============================================================================

import { useState, useCallback, useMemo, useEffect } from "react";
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
  Phone,
  MessageSquare,
  Send,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type { SensorSettings } from "../types";
import { DEFAULT_SETTINGS, getSettingsThresholds } from "../types";
import { z } from "zod";
import { fetchUsers, createUser, deleteUser, resetUserPassword, resetSettings as apiResetSettings, fetchRecipients, addRecipient, deleteRecipient, sendTestSms, updateRecipient, muteAlerts, getMuteStatus } from "../api/client";
import type { UserEntry, SmsRecipient } from "../api/client";

const SETTING_BOUNDS: Record<string, { min: number; max: number }> = {
  temp_min: { min: -10, max: 50 },
  temp_max: { min: -10, max: 50 },
  water_level_min: { min: 0, max: 100 },
  water_level_max: { min: 0, max: 100 },
  ammonia_min: { min: 0, max: 10 },
  ammonia_max: { min: 0, max: 10 },
};

const KEY_MAPPING: Record<string, { min: keyof SensorSettings; max: keyof SensorSettings }> = {
  temperature: { min: "temp_min", max: "temp_max" },
  water_level: { min: "water_level_min", max: "water_level_max" },
  ammonia: { min: "ammonia_min", max: "ammonia_max" },
};

const THRESHOLD_COLORS: Record<string, { bg: string; border: string }> = {
  temperature: { bg: "bg-blue-50", border: "border-blue-100" },
  water_level: { bg: "bg-indigo-50", border: "border-indigo-100" },
  ammonia: { bg: "bg-emerald-50", border: "border-emerald-100" },
};

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

  const [recipients, setRecipients] = useState<SmsRecipient[]>([]);
  const [isLoadingRecipients, setIsLoadingRecipients] = useState(true);
  const [showAddRecipient, setShowAddRecipient] = useState(false);
  const [newRecipient, setNewRecipient] = useState({ phone_number: "", name: "" });
  const [recipientErrors, setRecipientErrors] = useState<FormErrors>({});

  const [users, setUsers] = useState<UserEntry[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [resetModal, setResetModal] = useState<{ id: number; name: string; password: string; errors: FormErrors } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; username: string; type: "user" | "recipient" } | null>(null);
  const [toasts, setToasts] = useState<{ id: number; message: string; type: "success" | "error" }[]>([]);
  const [muteStatus, setMuteStatus] = useState<{ muted: boolean; muteExpires: string | null }>({ muted: false, muteExpires: null });
  const [muteLoading, setMuteLoading] = useState(false);

  useEffect(() => {
    getMuteStatus().then((s) => { if (s) setMuteStatus(s); });
  }, []);

  const showToast = useCallback((message: string, type: "success" | "error") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const handleMute = useCallback(async (hours: number | null) => {
    setMuteLoading(true);
    const result = await muteAlerts(hours);
    setMuteLoading(false);
    if (result) {
      setMuteStatus(result);
      showToast(result.muted ? `SMS alerts muted for ${hours} hours` : "SMS alerts unmuted", result.muted ? "success" : "success");
    }
  }, [showToast]);

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
  }, [localSettings, settings, saveSettings, validationErrors, logActivity]);

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

  const loadRecipients = useCallback(async () => {
    try {
      const data = await fetchRecipients();
      setRecipients(data);
    } catch {
      showToast("Failed to load recipients", "error");
    } finally {
      setIsLoadingRecipients(false);
    }
  }, [showToast]);

  const handleAddRecipient = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: FormErrors = {};
    if (!newRecipient.name.trim()) errors.name = "Name is required";
    if (!newRecipient.phone_number.trim()) errors.phone_number = "Phone number is required";
    else if (!/^\+639\d{9}$/.test(newRecipient.phone_number.trim())) errors.phone_number = "Format: +639XXXXXXXXX (11 digits)";
    setRecipientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setActionLoading("add-recipient");
    try {
      await addRecipient(newRecipient.phone_number.trim(), newRecipient.name.trim());
      showToast("Recipient added", "success");
      setNewRecipient({ phone_number: "", name: "" });
      setShowAddRecipient(false);
      await loadRecipients();
    } catch (err: unknown) {
      if (err instanceof Error) {
        const msg = err.message.includes("already exists") ? "Phone number already exists" : err.message;
        showToast(msg, "error");
      } else {
        showToast("Failed to add recipient", "error");
      }
    } finally {
      setActionLoading(null);
    }
  }, [newRecipient, showToast, loadRecipients]);

  const handleToggleRecipient = useCallback(async (id: number, current: boolean) => {
    try {
      await updateRecipient(id, { is_active: !current });
      setRecipients((prev) => prev.map((r) => (r.id === id ? { ...r, is_active: !current } : r)));
      showToast(!current ? "Recipient enabled" : "Recipient disabled", "success");
    } catch {
      showToast("Failed to update recipient", "error");
    }
  }, [showToast]);

  const handleDeleteRecipient = useCallback(async (id: number, name: string) => {
    setActionLoading(`delete-recipient-${id}`);
    try {
      await deleteRecipient(id);
      showToast(`"${name}" removed`, "success");
      setDeleteConfirm(null);
      await loadRecipients();
    } catch {
      showToast("Failed to delete recipient", "error");
    } finally {
      setActionLoading(null);
    }
  }, [showToast, loadRecipients]);

  const handleTestSms = useCallback(async (id: number, name: string) => {
    setActionLoading(`test-sms-${id}`);
    try {
      await sendTestSms(id);
      showToast(`Test SMS sent to ${name}`, "success");
    } catch {
      showToast("Failed to send test SMS", "error");
    } finally {
      setActionLoading(null);
    }
  }, [showToast]);

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRecipients();
  }, [loadRecipients]);

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
        if (err instanceof Error && err.message) {
          showToast(err.message, "error");
        } else {
          showToast("Failed to create user", "error");
        }
      } finally {
        setActionLoading(null);
      }
    }
  }, [form, validateForm, showToast, loadUsers]);

  const handleDeleteUser = useCallback(async (id: number) => {
    setActionLoading(`delete-${id}`);
    try {
      await deleteUser(id);
      showToast("User deleted successfully", "success");
      setDeleteConfirm(null);
      await loadUsers();
    } catch (err: unknown) {
      if (err instanceof Error && err.message) {
        showToast(err.message, "error");
      } else {
        showToast("Failed to delete user", "error");
      }
    } finally {
      setActionLoading(null);
    }
  }, [showToast, loadUsers]);

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

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-gray-500">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {showError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
          {localSaveError || saveError || settingsError}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="text-gray-600" size={20} />
          <h2 className="mt-0 text-gray-800">Settings</h2>
          {!isAdmin && <Lock size={16} className="text-gray-400" />}
        </div>
        <p className="text-gray-600 mb-0">
          {isAdmin
            ? "Configure sensor thresholds. Alerts are logged when values go outside the safe range."
            : "View sensor thresholds. Only administrators can modify these settings."}
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle className="text-orange-600" size={18} />
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
            Alert Thresholds
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(Object.keys(KEY_MAPPING) as Array<keyof typeof KEY_MAPPING>).map((key) => {
            const threshold = thresholdConfig[key];
            const keys = KEY_MAPPING[key];
            const colors = THRESHOLD_COLORS[key];

            return (
              <div
                key={key}
                className={`rounded-lg p-3 border ${colors.bg} ${colors.border}`}
              >
                <div className="text-xs font-semibold uppercase mb-2">
                  {threshold.name}
                  <span className="font-normal text-gray-500 ml-1">({threshold.unit})</span>
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
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg text-sm font-medium transition-colors"
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
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-800">SMS Recipients</h2>
                <p className="text-sm text-gray-500">Phone numbers that receive alert and hourly status messages</p>
              </div>
              {!showAddRecipient && (
                <button
                  onClick={() => setShowAddRecipient(true)}
                  className="flex items-center gap-2 bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white px-4 py-2 rounded-lg font-semibold text-sm hover:from-[#c2410c] hover:to-[#d94b1e] transition-all"
                >
                  <UserPlus size={16} />
                  Add Recipient
                </button>
              )}
            </div>

            {showAddRecipient && (
              <div className="bg-white rounded-lg shadow p-6 mb-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-md font-bold text-gray-800">Add New Recipient</h3>
                  <button
                    onClick={() => { setShowAddRecipient(false); setRecipientErrors({}); setNewRecipient({ phone_number: "", name: "" }); }}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X size={20} />
                  </button>
                </div>
                <form onSubmit={handleAddRecipient} className="flex flex-col sm:flex-row gap-3 items-end">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                    <input
                      type="text"
                      value={newRecipient.name}
                      onChange={(e) => { setNewRecipient((p) => ({ ...p, name: e.target.value })); if (recipientErrors.name) setRecipientErrors((p) => ({ ...p, name: "" })); }}
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] ${recipientErrors.name ? "border-red-500 bg-red-50" : "border-gray-300"}`}
                      placeholder="e.g. Admin, Manager"
                    />
                    {recipientErrors.name && <p className="mt-1 text-xs text-red-600">{recipientErrors.name}</p>}
                  </div>
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                    <input
                      type="text"
                      value={newRecipient.phone_number}
                      onChange={(e) => { setNewRecipient((p) => ({ ...p, phone_number: e.target.value })); if (recipientErrors.phone_number) setRecipientErrors((p) => ({ ...p, phone_number: "" })); }}
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#d94b1e]/20 focus:border-[#d94b1e] ${recipientErrors.phone_number ? "border-red-500 bg-red-50" : "border-gray-300"}`}
                      placeholder="+639XXXXXXXXX"
                    />
                    {recipientErrors.phone_number && <p className="mt-1 text-xs text-red-600">{recipientErrors.phone_number}</p>}
                  </div>
                  <button
                    type="submit"
                    disabled={actionLoading === "add-recipient"}
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 h-10"
                  >
                    {actionLoading === "add-recipient" ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
                    Add
                  </button>
                </form>
              </div>
            )}

            {isLoadingRecipients ? (
              <div className="bg-white rounded-lg shadow p-8 text-center">
                <Loader2 size={32} className="animate-spin mx-auto text-gray-400" />
                <p className="text-sm text-gray-500 mt-2">Loading recipients...</p>
              </div>
            ) : recipients.length === 0 ? (
              <div className="bg-white rounded-lg shadow p-8 text-center">
                <MessageSquare size={32} className="mx-auto text-gray-400 mb-2" />
                <p className="text-sm text-gray-500">No recipients added yet. Click "Add Recipient" to start receiving SMS alerts.</p>
              </div>
            ) : (
              <div className="bg-white rounded-lg shadow overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Name</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Phone</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Added</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {recipients.map((r) => (
                        <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <Phone size={14} className="text-gray-400" />
                              <p className="font-medium text-gray-800 text-sm">{r.name}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 font-mono">{r.phone_number}</td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => handleToggleRecipient(r.id, r.is_active)}
                              className="flex items-center gap-1 text-sm font-semibold"
                            >
                              {r.is_active ? (
                                <ToggleRight size={20} className="text-emerald-500" />
                              ) : (
                                <ToggleLeft size={20} className="text-gray-400" />
                              )}
                              <span className={r.is_active ? "text-emerald-600" : "text-gray-400"}>
                                {r.is_active ? "Active" : "Disabled"}
                              </span>
                            </button>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {new Date(r.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => handleTestSms(r.id, r.name)}
                                disabled={actionLoading === `test-sms-${r.id}`}
                                className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-md transition-colors disabled:opacity-50"
                                title="Send Test SMS"
                              >
                                {actionLoading === `test-sms-${r.id}` ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                                Test
                              </button>
                              <button
                                onClick={() => setDeleteConfirm({ id: r.id, username: r.name, type: "recipient" })}
                                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                title="Delete Recipient"
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

          <div>
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare className="text-orange-600" size={18} />
              <h2 className="text-lg font-bold text-gray-800">SMS Alert Sleep / Mute</h2>
            </div>
            <p className="text-sm text-gray-500 mb-4">Temporarily pause SMS alerts for device disconnections and threshold warnings</p>

            {muteStatus.muted && muteStatus.muteExpires && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                <div className="flex items-center gap-2">
                  <ToggleRight size={18} className="text-amber-600" />
                  <span className="text-sm font-semibold text-amber-800">SMS alerts muted until {new Date(muteStatus.muteExpires).toLocaleString()}</span>
                </div>
              </div>
            )}

            <div className="bg-white rounded-lg shadow p-4">
              <div className="grid grid-cols-4 sm:grid-cols-7 gap-2 mb-3">
                {[1, 2, 4, 6, 8, 12, 24].map((hours) => (
                  <button
                    key={hours}
                    onClick={() => handleMute(hours)}
                    disabled={muteLoading}
                    className="px-3 py-2 text-sm font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-orange-300 transition-all disabled:opacity-50"
                  >
                    {hours}h
                  </button>
                ))}
              </div>
              {muteStatus.muted && (
                <button
                  onClick={() => handleMute(null)}
                  disabled={muteLoading}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 transition-all disabled:opacity-50"
                >
                  <ToggleLeft size={16} />
                  Unmute Alerts
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-gray-800">User Management</h2>
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
                          <div>
                            <p className="font-medium text-gray-800 text-sm">{u.name}</p>
                            <p className="text-xs text-gray-500">{u.email}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-mono">{u.username}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                            u.role === "admin"
                              ? "bg-purple-100 text-purple-700"
                              : "bg-blue-100 text-blue-700"
                          }`}>
                            {u.role === "admin" ? <Shield size={12} /> : <User size={12} />}
                            {u.role}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {new Date(u.created_at).toLocaleDateString()}
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
                                onClick={() => setDeleteConfirm({ id: u.id, username: u.username, type: "user" })}
                                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                title="Delete User"
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

          <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-4">
            <div className="flex gap-3">
              <CheckCircle2 className="text-amber-600 shrink-0 mt-0.5" size={20} />
              <div>
                <p className="text-sm font-semibold text-amber-800">Default Admin Account</p>
                <p className="text-xs text-amber-700 mt-1">
                  Username: <span className="font-mono">admin</span> | Password: <span className="font-mono">Admin@123</span>
                </p>
                <p className="text-xs text-amber-600 mt-1">Change this password after your first login for security.</p>
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="text-red-600" size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-800">
                  {deleteConfirm.type === "user" ? "Delete User" : "Delete Recipient"}
                </h3>
                <p className="text-sm text-gray-500">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-6">
              {deleteConfirm.type === "user" ? (
                <>Are you sure you want to delete the account <span className="font-semibold">{deleteConfirm.username}</span>?</>
              ) : (
                <>Are you sure you want to remove <span className="font-semibold">{deleteConfirm.username}</span> from receiving SMS alerts?</>
              )}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteConfirm.type === "user" ? handleDeleteUser(deleteConfirm.id) : handleDeleteRecipient(deleteConfirm.id, deleteConfirm.username)}
                disabled={actionLoading === `delete-${deleteConfirm.id}` || actionLoading === `delete-recipient-${deleteConfirm.id}`}
                className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {actionLoading === `delete-${deleteConfirm.id}` || actionLoading === `delete-recipient-${deleteConfirm.id}` ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                Delete
              </button>
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
