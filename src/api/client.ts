// =============================================================================
// FILE: src/api/client.ts
// =============================================================================
// PURPOSE: Centralized API client for all backend communication.
//
// This file provides typed wrapper functions around axios that call every
// backend API endpoint. It handles:
//   - Axios instance creation with base URL and timeout
//   - Automatic Bearer token injection via request interceptors
//   - Error classification (ApiError with statusCode and isNetworkError)
//   - Data transformation (e.g., sensor history → ChartPoint format)
//   - AbortSignal support for cancellable requests
//
// Every function in this file corresponds to a specific backend route
// defined in server.cjs. The functions are used by:
//   - SensorProvider (data polling hooks)
//   - SettingsPage, AuthPage, LogsPage, etc. (UI interactions)
//   - DeviceConnectionMonitor (disconnect alerts)
//
// USAGE PATTERN:
//   import { fetchLatestSensor, saveSettings } from "../api/client";
//   const data = await fetchLatestSensor();
//   await saveSettings({ temp_min: 22, temp_max: 30 });
// =============================================================================

import axios, { isAxiosError, type AxiosError } from "axios";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings, ActivityLog, ActivityLogEntry, AuthResponse, WeeklyReport } from "../types";
import { API_BASE } from "../types";

// ========================
// USER TYPE (Admin Management)
// ========================
/** Represents a user account in the system (admin management). */
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
// Creates a pre-configured axios instance for all API calls.
// - baseURL: Automatically determined from environment (local or production)
// - timeout: 10 seconds max per request to prevent hanging
// - Content-Type: Always application/json

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
// Automatically attaches the authentication token to every outgoing request.
// The token is stored in localStorage under "crayvings_token" after login.
// This eliminates the need to manually pass the token with each API call.

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
// Handles network errors silently to prevent UI crashes from transient failures.
// Connection timeouts and canceled requests are not treated as errors here
// (they are handled at the call site).
// A 401 on a protected route means the token is invalid or expired — clear the
// stored session so the app returns to the login page on next load.

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
// Extends Error with HTTP-specific properties for better error handling in UI.

/**
 * Custom error class for API failures.
 * Includes HTTP status code and network error flag for UI handling.
 */
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

/**
 * GET /sensor/latest
 * Fetches the most recent sensor reading from the database.
 * Returns null if no data exists or the request is canceled.
 * Called every 3 seconds by the SensorProvider for real-time updates.
 */
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

/**
 * GET /sensor
 * Fetches sensor history for chart rendering.
 * Transforms raw SensorEntry[] into ChartPoint[] format:
 *   - Sorts by timestamp (oldest first for chronological charts)
 *   - Formats timestamps as human-readable time labels
 *   - Normalizes failed-sensor sentinels (temperature 0, water_level/ammonia -1) to null so
 *     charts show gaps and stats exclude them
 * Called on initial load and when switching time ranges in HistoricalDataPage.
 */
export async function fetchSensorHistory(limit = 1000, signal?: AbortSignal): Promise<ChartPoint[]> {
  const response = await client.get<SensorEntry[]>("/sensor", {
    params: { limit },
    signal,
  });
  
  // Transform and sort data for chart display
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
        name: timestamp
          ? timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "--:--",
        timestamp: timestamp ? timestamp.toISOString() : "",
        // The ESP32 sends temperature 0 and water_level/ammonia -1 when a sensor fails.
        // These match the server's minValid checks; anything below them is a
        // failed sensor, not a real reading.
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

/**
 * GET /report/weekly
 * Fetches aggregated weekly report data from the backend.
 * Returns summary stats, daily breakdown, and alert counts for the past 7 days.
 */
export async function fetchWeeklyReport(signal?: AbortSignal): Promise<WeeklyReport> {
  const response = await client.get<WeeklyReport>("/report/weekly", { signal });
  return response.data;
}

// ========================
// SYSTEM LOGS ENDPOINTS
// ========================

/** Response shape for paginated system logs. */
export interface LogsResponse {
  data: LogEntry[];
  total: number;
  page: number;
  limit: number;
  counts: Record<string, number>;
}

/** Optional filters for paginated system logs (applied server-side). */
export interface LogsFilter {
  action?: string;
  parameter?: string;
}

/**
 * GET /system-logs
 * Fetches paginated system log entries.
 * Used by AlertsPage and LogsPage to display alert history.
 */
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

/**
 * GET /settings
 * Fetches current sensor threshold settings.
 * Converts PostgreSQL NUMERIC strings to JavaScript numbers.
 * Used by SensorProvider on initialization and when settings change.
 */
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
    ammonia_max: Number(data.ammonia_max ?? 1),
    updated_at: data.updated_at as string,
  };
}

/**
 * POST /settings (Admin only)
 * Saves updated sensor threshold settings.
 * Requires admin authentication (token sent via interceptor).
 */
export async function saveSettings(settings: Partial<SensorSettings>, signal?: AbortSignal): Promise<void> {
  await client.post("/settings", settings, { signal });
}

/**
 * POST /settings/reset (Admin only)
 * Resets all thresholds to factory defaults.
 * Returns the new settings after reset.
 */
export async function resetSettings(signal?: AbortSignal): Promise<SensorSettings> {
  const response = await client.post<{ data: SensorSettings }>("/settings/reset", {}, { signal });
  return response.data.data;
}

// ========================
// SMS RECIPIENT ENDPOINTS
// ========================

/** Represents an SMS recipient in the authorized_recipients table. */
export interface SmsRecipient {
  id: number;
  phone_number: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

/** GET /settings/recipients - Fetches all authorized SMS recipients. */
export async function fetchRecipients(signal?: AbortSignal): Promise<SmsRecipient[]> {
  const response = await client.get<SmsRecipient[]>("/settings/recipients", { signal });
  return response.data;
}

/** POST /settings/recipients - Adds a new SMS recipient. */
export async function addRecipient(phone_number: string, name: string, signal?: AbortSignal): Promise<SmsRecipient> {
  const response = await client.post<{ data: SmsRecipient }>("/settings/recipients", { phone_number, name }, { signal });
  return response.data.data;
}

/** PUT /settings/recipients/:id - Updates a recipient's name or active status. */
export async function updateRecipient(id: number, updates: Partial<SmsRecipient>, signal?: AbortSignal): Promise<SmsRecipient> {
  const response = await client.put<{ data: SmsRecipient }>(`/settings/recipients/${id}`, updates, { signal });
  return response.data.data;
}

/** DELETE /settings/recipients/:id - Removes an SMS recipient. */
export async function deleteRecipient(id: number, signal?: AbortSignal): Promise<void> {
  await client.delete(`/settings/recipients/${id}`, { signal });
}

/** POST /settings/recipients/test/:id - Sends a test SMS to verify a recipient. */
export async function sendTestSms(id: number, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
  const response = await client.post(`/settings/recipients/test/${id}`, {}, { signal });
  return response.data;
}

// ========================
// LOG CREATION ENDPOINT
// ========================

/**
 * POST /logs
 * Creates a new system log entry.
 * Called internally when sensor alerts are triggered or settings change.
 */
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

/** GET /health - Checks if the backend server is running and responsive. */
export async function checkHealth(signal?: AbortSignal): Promise<{ status: string; serverTime: string }> {
  const response = await client.get("/health", { signal });
  return response.data;
}

// ========================
// ALERT MANAGEMENT ENDPOINTS
// ========================

/** Response shape for paginated activity logs. */
export interface ActivityLogsResponse {
  data: ActivityLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * POST /alert/device-disconnect
 * Triggers SMS alerts to all active recipients when the ESP32 disconnects.
 * Called by DeviceConnectionMonitor when connection status changes to "offline".
 * Returns null on failure (graceful degradation - UI continues without alert).
 */
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

/**
 * POST /alert/mute
 * Mutes SMS alerts for a specified number of hours, or unmutes if hours is null.
 * Used by the Settings page and FloatingAlert component.
 */
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

/** GET /alert/mute-status - Checks if SMS alerts are currently muted. */
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

/**
 * POST /activity-logs
 * Records a user activity event for audit trail.
 * Returns null on failure (non-critical - logging failure shouldn't break UX).
 */
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

/**
 * GET /activity-logs
 * Fetches paginated, searchable, filterable activity logs.
 * Used by ActivityLogsPage for the activity monitoring dashboard.
 */
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

/**
 * POST /auth/login
 * Authenticates a user and returns a session token.
 * The token is stored in localStorage by AuthContext for subsequent requests.
 */
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

/**
 * POST /auth/logout (Authenticated)
 * Revokes the current session token server-side.
 * Called by AuthContext.logout; failures are silent since local
 * session state is cleared regardless.
 */
export async function logoutUser(signal?: AbortSignal): Promise<void> {
  try {
    await client.post("/auth/logout", {}, { signal });
  } catch {
    // Non-critical — local session is cleared by the caller anyway.
  }
}

/** GET /auth/users (Admin only) - Fetches all user accounts. */
export async function fetchUsers(signal?: AbortSignal): Promise<UserEntry[]> {
  const response = await client.get<UserEntry[]>("/auth/users", { signal });
  return response.data;
}

/** POST /auth/users (Admin only) - Creates a new user account. */
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

/** DELETE /auth/users/:id (Admin only) - Deletes a user account. */
export async function deleteUser(
  userId: number,
  signal?: AbortSignal
): Promise<void> {
  await client.delete(`/auth/users/${userId}`, { signal });
}

/** PUT /auth/users/:id/password (Admin only) - Resets a user's password. */
export async function resetUserPassword(
  userId: number,
  newPassword: string,
  signal?: AbortSignal
): Promise<void> {
  await client.put(`/auth/users/${userId}/password`, { newPassword }, { signal });
}

// Export the axios client instance for direct use if needed
export default client;
