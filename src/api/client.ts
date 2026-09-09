// =============================================================================
// FILE: src/api/client.ts
// =============================================================================
// PURPOSE: Centralized API client with typed wrappers for every backend endpoint.
// =============================================================================

import axios, { isAxiosError, type AxiosError } from "axios";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings, ActivityLog, ActivityLogEntry, AuthResponse, WeeklyReport } from "../types";
import { API_BASE } from "../types";
import { formatFarmTime } from "../utils/time";

// ========================
// USER TYPE (Admin Management)
// ========================
export interface UserEntry {
  id: number;
  name: string;
  username: string;
  email: string;
  role: string;
  created_at: string;
}

// ========================
// AXIOS CLIENT INSTANCE
// ========================

const client = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: {
    "Content-Type": "application/json",
  },
});

// ========================
// REQUEST INTERCEPTOR
// ========================
// Attaches the auth token from localStorage to every request.

client.interceptors.request.use((config) => {
  const token = localStorage.getItem("crayvings_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ========================
// RESPONSE INTERCEPTOR
// ========================
// Timeouts/cancels are left to the call site. A 401 clears the stored
// session so the app returns to login on next load.

client.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.code !== "ECONNABORTED" && error.code !== "ERR_CANCELED") {
      // Silent fail for network errors - handled by calling code
    }
    if (error.response?.status === 401 && localStorage.getItem("crayvings_token")) {
      localStorage.removeItem("crayvings_token");
      localStorage.removeItem("crayvings_user");
    }
    return Promise.reject(error);
  }
);

// ========================
// CUSTOM ERROR CLASS
// ========================

// API failure error with HTTP status and network-error flag for UI handling
export class ApiError extends Error {
  statusCode: number | undefined;
  isNetworkError: boolean;
  constructor(message: string, statusCode?: number, isNetworkError = false) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.isNetworkError = isNetworkError;
  }
}

// ========================
// SENSOR DATA ENDPOINTS
// ========================

// GET /sensor/latest - fetch latest reading; null when none/canceled
export async function fetchLatestSensor(signal?: AbortSignal): Promise<SensorEntry | null> {
  try {
    const response = await client.get<SensorEntry>("/sensor/latest", { signal });
    return response.data;
  } catch (error) {
    if (isAxiosError(error) && error.code === "ERR_CANCELED") {
      return null;
    }
    if (isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

// GET /sensor - fetch sensor history sorted oldest-first as ChartPoints for charts
export async function fetchSensorHistory(limit = 1000, signal?: AbortSignal): Promise<ChartPoint[]> {
  const response = await client.get<SensorEntry[]>("/sensor", {
    params: { limit },
    signal,
  });
  
  const data = (response.data || [])
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.timestamp || 0).getTime();
      const tb = new Date(b.timestamp || 0).getTime();
      return ta - tb;
    })
    .map((item) => {
      const timestamp = item.timestamp ? new Date(item.timestamp) : null;
      return {
        name: timestamp ? formatFarmTime(timestamp) : "--:--",
        timestamp: timestamp ? timestamp.toISOString() : "",
        // ESP32 failed-sensor sentinels: temperature 0, water_level/ammonia -1
        // (below server minValid, not real readings)
        temperature: item.temperature !== undefined && item.temperature >= 0.0001 ? item.temperature : null,
        water_level: item.water_level !== undefined && item.water_level >= 0 ? item.water_level : null,
        ammonia: item.ammonia !== undefined && item.ammonia >= 0 ? item.ammonia : null,
      };
    });
  
  return data;
}

// ========================
// WEEKLY REPORT ENDPOINT
// ========================

// GET /report/weekly - fetch 7-day aggregate report stats
export async function fetchWeeklyReport(signal?: AbortSignal): Promise<WeeklyReport> {
  const response = await client.get<WeeklyReport>("/report/weekly", { signal });
  return response.data;
}

// ========================
// SYSTEM LOGS ENDPOINTS
// ========================

// Response shape for paginated system logs
export interface LogsResponse {
  data: LogEntry[];
  total: number;
  page: number;
  limit: number;
  counts: Record<string, number>;
}

// Optional server-side filters for paginated system logs
export interface LogsFilter {
  action?: string;
  parameter?: string;
}

// GET /system-logs - fetch paginated system log entries
export async function fetchLogs(
  page = 1,
  limit = 20,
  signal?: AbortSignal,
  filter?: LogsFilter
): Promise<LogsResponse> {
  const response = await client.get<{ data: LogEntry[]; total: number; counts?: Record<string, number> }>("/system-logs", {
    params: { page, limit, action: filter?.action, parameter: filter?.parameter },
    signal,
  });
  return {
    data: response.data.data || [],
    total: response.data.total || 0,
    page,
    limit,
    counts: response.data.counts || {},
  };
}

// ========================
// SETTINGS ENDPOINTS
// ========================

// GET /settings - fetch thresholds, converting PostgreSQL NUMERIC strings to numbers
export async function fetchSettings(signal?: AbortSignal): Promise<SensorSettings> {
  const response = await client.get<SensorSettings>("/settings", { signal });
  const data = response.data as Record<string, unknown>;
  return {
    id: data.id as number,
    temp_min: Number(data.temp_min),
    temp_max: Number(data.temp_max),
    water_level_min: Number(data.water_level_min),
    water_level_max: Number(data.water_level_max),
    ammonia_min: Number(data.ammonia_min ?? 0),
    ammonia_max: Number(data.ammonia_max ?? 25),
    updated_at: data.updated_at as string,
  };
}

// POST /settings (Admin only) - save sensor thresholds
export async function saveSettings(settings: Partial<SensorSettings>, signal?: AbortSignal): Promise<void> {
  await client.post("/settings", settings, { signal });
}

// POST /settings/reset (Admin only) - reset thresholds to factory defaults
export async function resetSettings(signal?: AbortSignal): Promise<SensorSettings> {
  const response = await client.post<{ data: SensorSettings }>("/settings/reset", {}, { signal });
  return response.data.data;
}

// ========================
// SMS RECIPIENT ENDPOINTS
// ========================

// SMS recipient in the authorized_recipients table
export interface SmsRecipient {
  id: number;
  phone_number: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

// GET /settings/recipients - fetch all authorized SMS recipients
export async function fetchRecipients(signal?: AbortSignal): Promise<SmsRecipient[]> {
  const response = await client.get<SmsRecipient[]>("/settings/recipients", { signal });
  return response.data;
}

// POST /settings/recipients - add a new SMS recipient
export async function addRecipient(phone_number: string, name: string, signal?: AbortSignal): Promise<SmsRecipient> {
  const response = await client.post<{ data: SmsRecipient }>("/settings/recipients", { phone_number, name }, { signal });
  return response.data.data;
}

// PUT /settings/recipients/:id - update a recipient's name or active status
export async function updateRecipient(id: number, updates: Partial<SmsRecipient>, signal?: AbortSignal): Promise<SmsRecipient> {
  const response = await client.put<{ data: SmsRecipient }>(`/settings/recipients/${id}`, updates, { signal });
  return response.data.data;
}

// DELETE /settings/recipients/:id - remove an SMS recipient
export async function deleteRecipient(id: number, signal?: AbortSignal): Promise<void> {
  await client.delete(`/settings/recipients/${id}`, { signal });
}

// POST /settings/recipients/test/:id - send a test SMS to verify a recipient
export async function sendTestSms(id: number, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
  const response = await client.post(`/settings/recipients/test/${id}`, {}, { signal });
  return response.data;
}

// ========================
// LOG CREATION ENDPOINT
// ========================

// POST /logs - create a new system log entry
export async function createLog(
  action: string,
  parameter: string,
  oldValue: string | number,
  newValue: string | number,
  signal?: AbortSignal
): Promise<LogEntry> {
  const response = await client.post<{ data: LogEntry }>(
    "/logs",
    {
      action,
      parameter,
      old_value: oldValue,
      new_value: newValue,
    },
    { signal }
  );
  return response.data.data;
}

// ========================
// HEALTH CHECK
// ========================

// GET /health - check backend is running and responsive
export async function checkHealth(signal?: AbortSignal): Promise<{ status: string; serverTime: string }> {
  const response = await client.get("/health", { signal });
  return response.data;
}

// ========================
// ALERT MANAGEMENT ENDPOINTS
// ========================

// Response shape for paginated activity logs
export interface ActivityLogsResponse {
  data: ActivityLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// POST /alert/device-disconnect - SMS all active recipients on ESP32 disconnect
export async function sendDeviceDisconnectAlert(
  description?: string,
  consecutiveFailures?: number,
  signal?: AbortSignal
): Promise<{ sent: number; total: number } | null> {
  try {
    const response = await client.post(
      '/alert/device-disconnect',
      { event_type: 'disconnect', description, consecutive_failures: consecutiveFailures },
      { signal }
    );
    return response.data;
  } catch {
    console.error('Failed to send device disconnect alert');
    return null;
  }
}

// POST /alert/mute - mute SMS alerts for N hours, or unmute when hours is null
export async function muteAlerts(hours: number | null, signal?: AbortSignal): Promise<{ muted: boolean; muteExpires: string | null } | null> {
  try {
    const response = await client.post(
      '/alert/mute',
      { hours },
      { signal }
    );
    return response.data;
  } catch {
    console.error('Failed to set alert mute');
    return null;
  }
}

// GET /alert/mute-status - check whether SMS alerts are currently muted
export async function getMuteStatus(signal?: AbortSignal): Promise<{ muted: boolean; muteExpires: string | null } | null> {
  try {
    const response = await client.get('/alert/mute-status', { signal });
    return response.data;
  } catch {
    console.error('Failed to get mute status');
    return null;
  }
}

// ========================
// ACTIVITY LOG ENDPOINTS
// ========================

// POST /activity-logs - record a user activity event for audit trail
export async function logActivity(
  entry: ActivityLogEntry,
  signal?: AbortSignal
): Promise<ActivityLog | null> {
  try {
    const response = await client.post<{ data: ActivityLog }>(
      "/activity-logs",
      entry,
      { signal }
    );
    return response.data.data;
  } catch {
    console.error("Failed to log activity:", entry);
    return null;
  }
}

// GET /activity-logs - fetch paginated, searchable, filterable activity logs
export async function fetchActivityLogs(
  page = 1,
  limit = 20,
  search = "",
  sortBy: "newest" | "oldest" = "newest",
  actionType?: string,
  signal?: AbortSignal
): Promise<ActivityLogsResponse> {
  const response = await client.get<ActivityLogsResponse>("/activity-logs", {
    params: { page, limit, search, sortBy, actionType },
    signal,
  });
  return response.data;
}

// ========================
// AUTHENTICATION ENDPOINTS
// ========================

// POST /auth/login - authenticate and return a session token
export async function loginUser(
  username: string,
  password: string,
  signal?: AbortSignal
): Promise<AuthResponse> {
  const response = await client.post<AuthResponse>(
    "/auth/login",
    { username, password },
    { signal }
  );
  return response.data;
}

// POST /auth/logout - revoke the current session token server-side
export async function logoutUser(signal?: AbortSignal): Promise<void> {
  try {
    await client.post("/auth/logout", {}, { signal });
  } catch {
    // Non-critical — local session is cleared by the caller anyway.
  }
}

// GET /auth/users (Admin only) - fetch all user accounts
export async function fetchUsers(signal?: AbortSignal): Promise<UserEntry[]> {
  const response = await client.get<UserEntry[]>("/auth/users", { signal });
  return response.data;
}

// POST /auth/users (Admin only) - create a new user account
export async function createUser(
  name: string,
  username: string,
  email: string,
  password: string,
  role: string,
  signal?: AbortSignal
): Promise<UserEntry> {
  const response = await client.post<{ data: UserEntry }>(
    "/auth/users",
    { name, username, email, password, role },
    { signal }
  );
  return response.data.data;
}

// DELETE /auth/users/:id (Admin only) - delete a user account
export async function deleteUser(
  userId: number,
  signal?: AbortSignal
): Promise<void> {
  await client.delete(`/auth/users/${userId}`, { signal });
}

// PUT /auth/users/:id/password (Admin only) - reset a user's password
export async function resetUserPassword(
  userId: number,
  newPassword: string,
  signal?: AbortSignal
): Promise<void> {
  await client.put(`/auth/users/${userId}/password`, { newPassword }, { signal });
}

export default client;
