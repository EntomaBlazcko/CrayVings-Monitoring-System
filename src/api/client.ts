// =============================================================================
// FILE: src/api/client.ts
// =============================================================================
// PURPOSE: Centralized API client with typed wrappers for every backend endpoint.
// =============================================================================

import axios, { isAxiosError, type AxiosError } from "axios";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings, ActivityLog, ActivityLogEntry, AuthResponse, WeeklyReport, AnalyticsOverview, AnalyticsDailyResponse, AnalyticsInsightsResponse } from "../types";
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
  owner?: boolean;
  protected?: boolean;
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
  (error: AxiosError<{ message?: unknown }>) => {
    // Aborted requests (fetch cancel, component unmount) are not errors — the
    // call sites handle them silently, so leave their message untouched.
    if (error.code === "ERR_CANCELED") return Promise.reject(error);

    // The server always replies with a { message } on failures. Substituting
    // it for axios's default "Request failed with status code 401" means every
    // UI that shows error.message displays the real reason (e.g. "Invalid
    // credentials", "Incorrect password", "Session expired, please log in
    // again") instead of a generic HTTP-status string.
    const serverMsg =
      error.response?.data &&
      typeof (error.response.data as { message?: unknown }).message === "string"
        ? ((error.response.data as { message?: unknown }).message as string)
        : "";

    if (serverMsg) {
      error.message = serverMsg;
    } else if (!error.response) {
      // No HTTP response at all -> network unreachable or timed out.
      error.message =
        error.code === "ECONNABORTED"
          ? "The request timed out. The server may be busy."
          : "Cannot reach the server. Check your connection.";
    }

    // A session is "gone" when the server no longer recognizes the token.
    //   * 401 with no message / "Authentication required" / "Session expired"
    //     = the server rejected or cleared the token.
    //   * 403 "Invalid token" = the stored token no longer matches any session
    //     (e.g. it was overwritten by another login on the same account).
    // Both should end the local session instead of leaving a broken page behind.
    // Other 401/403s (wrong password/OTP, admin-only route) must NOT log the
    // user out — that would kick the admin to the login screen mid-flow.
    if (localStorage.getItem("crayvings_token")) {
      const status = error.response?.status;
      const sessionLost =
        (status === 401 &&
          (!serverMsg ||
            serverMsg === "Authentication required" ||
            serverMsg.includes("Session expired"))) ||
        (status === 403 && serverMsg === "Invalid token");
      if (sessionLost) {
        localStorage.removeItem("crayvings_token");
        localStorage.removeItem("crayvings_user");
        // Notify AuthProvider so the app returns to the login screen.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("crayvings_unauthorized"));
        }
      }
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
        // (below server minValid, not real readings). Columns are DECIMAL so pg
        // returns strings — coerce to numbers here.
        temperature: item.temperature !== undefined && Number(item.temperature) >= 0.0001 ? Number(item.temperature) : null,
        water_level: item.water_level !== undefined && Number(item.water_level) >= 0 ? Number(item.water_level) : null,
        ammonia: item.ammonia !== undefined && Number(item.ammonia) >= 0 ? Number(item.ammonia) : null,
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

// GET /report/range - aggregate report for a custom window.
// hours: positive int (last N hours, hourly buckets when <= 24) or null (all time).
export async function fetchRangeReport(hours: number | null, signal?: AbortSignal): Promise<WeeklyReport> {
  const params = hours && hours > 0 ? { hours } : {};
  const response = await client.get<WeeklyReport>("/report/range", { params, signal });
  return response.data;
}

// ========================
// ANALYTICS ENDPOINTS
// ========================

// GET /analytics/overview - period summary, trends, alerts, uptime stats
export async function fetchAnalyticsOverview(days = 7, signal?: AbortSignal): Promise<AnalyticsOverview> {
  const response = await client.get<AnalyticsOverview>("/analytics/overview", {
    params: { days },
    signal,
  });
  return response.data;
}

// GET /analytics/daily - per-day aggregates for charting
export async function fetchAnalyticsDaily(days = 30, signal?: AbortSignal): Promise<AnalyticsDailyResponse> {
  const response = await client.get<AnalyticsDailyResponse>("/analytics/daily", {
    params: { days },
    signal,
  });
  return response.data;
}

// GET /analytics/insights - rule-engine suggestions for the selected period
export async function fetchAnalyticsInsights(days = 7, signal?: AbortSignal): Promise<AnalyticsInsightsResponse> {
  const response = await client.get<AnalyticsInsightsResponse>("/analytics/insights", {
    params: { days },
    signal,
  });
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

// POST /logs/:id/ack - mark a specific alert log as confirmed (done) or allowed
// (approved). The status is stored on the alert row itself, so it survives
// reloads without needing to replay extra log entries.
export async function acknowledgeLog(
  logId: number,
  status: "confirmed" | "allowed",
  signal?: AbortSignal
): Promise<LogEntry> {
  const response = await client.post<{ data: LogEntry }>(
    `/logs/${logId}/ack`,
    { status },
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
// ACTIVITY LOG ENDPOINTS
// ========================

// Response shape for paginated activity logs
export interface ActivityLogsResponse {
  data: ActivityLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

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

// -----------------------------------------------------------------------------
// SECURE USER DELETION (EMAIL OTP 2-STEP) — replaces the old hard delete.
// POST /auth/users/:id/deletion-request  (password + reason) -> emails OTP
// POST /auth/users/:id/deletion-verify   (request_id + code) -> hard deletes
// -----------------------------------------------------------------------------

export interface DeletionRequestResponse {
  message: string;
  request_id: number;
  otp_sent: boolean;
  email_to?: string;
  dev_fallback: boolean;
  reason?: string;
}

export interface DeletionRequestEntry {
  id: number;
  user_id: number;
  user_username: string;
  requester_username: string;
  status: string;
  requested_at: string;
  otp_verified_at: string | null;
  executed_at: string | null;
  reason: string | null;
}

// STEP 1 - Admin confirms their own password; server emails a 6-digit OTP to the
// target user's address and returns an opaque request_id.
export async function requestUserDeletion(
  userId: number,
  password: string,
  reason?: string,
  signal?: AbortSignal
): Promise<DeletionRequestResponse> {
  const response = await client.post<DeletionRequestResponse>(
    `/auth/users/${userId}/deletion-request`,
    { password, reason },
    { signal }
  );
  return response.data;
}

// STEP 2 - Admin submits the emailed OTP; on success the user row is hard-deleted
// and the full audit chain (requester -> OTP -> executor -> activity log) is written.
export async function verifyUserDeletion(
  userId: number,
  request_id: number,
  code: string,
  signal?: AbortSignal
): Promise<{ message: string; username?: string }> {
  const response = await client.post<{ message: string; username?: string }>(
    `/auth/users/${userId}/deletion-verify`,
    { request_id, code },
    { signal }
  );
  return response.data;
}

// GET /auth/users/deletion-requests (Admin) - pending deletion audit trail
export async function fetchDeletionRequests(signal?: AbortSignal): Promise<DeletionRequestEntry[]> {
  const response = await client.get<DeletionRequestEntry[]>("/auth/users/deletion-requests", { signal });
  return response.data;
}

// DELETE /auth/users/:id (Admin only) - legacy direct delete (kept for compatibility)
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

// ========================
// SMS ALERT TYPES
// ========================
export interface SmsRecipient {
  id: number;
  phone_number: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface MuteStatus {
  muted: boolean;
  muteExpires: string | null;
}

// GET /settings/recipients (Admin) - list SMS recipients
export async function fetchSmsRecipients(signal?: AbortSignal): Promise<SmsRecipient[]> {
  const response = await client.get<SmsRecipient[]>("/settings/recipients", { signal });
  return response.data;
}

// POST /settings/recipients (Admin) - add an SMS recipient
export async function addSmsRecipient(
  payload: { phone_number: string; name: string },
  signal?: AbortSignal
): Promise<SmsRecipient> {
  const response = await client.post<SmsRecipient>("/settings/recipients", payload, { signal });
  return response.data;
}

// PUT /settings/recipients/:id (Admin) - rename and/or toggle a recipient
export async function updateSmsRecipient(
  id: number,
  payload: { name?: string; is_active?: boolean },
  signal?: AbortSignal
): Promise<SmsRecipient> {
  const response = await client.put<SmsRecipient>(`/settings/recipients/${id}`, payload, { signal });
  return response.data;
}

// DELETE /settings/recipients/:id (Admin) - remove a recipient
export async function deleteSmsRecipient(id: number, signal?: AbortSignal): Promise<void> {
  await client.delete(`/settings/recipients/${id}`, { signal });
}

// POST /settings/recipients/test/:id (Admin) - deliver a test SMS to one recipient
export async function sendTestSms(id: number, signal?: AbortSignal): Promise<{ message: string }> {
  const response = await client.post<{ message: string }>(`/settings/recipients/test/${id}`, {}, { signal });
  return response.data;
}

// POST /alert/status (Admin) - send the status update SMS immediately
export async function sendStatusSms(signal?: AbortSignal): Promise<{ sent: number; total: number }> {
  const response = await client.post<{ sent: number; total: number }>("/alert/status", {}, { signal });
  return response.data;
}

// POST /alert/mute (Admin) - silence SMS for N hours (0 = unmute)
export async function setSmsMute(hours: number, signal?: AbortSignal): Promise<MuteStatus> {
  const response = await client.post<MuteStatus>("/alert/mute", { hours }, { signal });
  return response.data;
}

// GET /alert/mute-status - current SMS mute state
export async function fetchSmsMuteStatus(signal?: AbortSignal): Promise<MuteStatus> {
  const response = await client.get<MuteStatus>("/alert/mute-status", { signal });
  return response.data;
}

export interface SmsLogEntry {
  id: number;
  recipient_phone: string;
  message: string;
  status: string;
  error_message: string | null;
  failure_reason: string | null;
  sms_id: string | null;
  sent_at: string;
  delivered_at: string | null;
}

export interface SmsLogPage {
  rows: SmsLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SmsHealth {
  configured: boolean;
  from: string | null;
  smsToday: number;
  smsCap: number;
  last24h: { processed: number; failed: number; capped: number; stuckQueued: number };
  degraded: boolean;
  latestFailure: SmsLogEntry | null;
}

// GET /sms-logs (Admin) - paginated SMS history
export async function fetchSmsLogs(
  params: { page?: number; pageSize?: number; status?: string },
  signal?: AbortSignal
): Promise<SmsLogPage> {
  const response = await client.get<SmsLogPage>("/sms-logs", { params, signal });
  return response.data;
}

// GET /alert/sms-health - SMS delivery health snapshot
export async function fetchSmsHealth(signal?: AbortSignal): Promise<SmsHealth> {
  const response = await client.get<SmsHealth>("/alert/sms-health", { signal });
  return response.data;
}

export default client;
