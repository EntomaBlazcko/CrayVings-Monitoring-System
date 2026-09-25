// Central frontend types, constants, and threshold logic.

// Sensor data types

// Raw data from the ESP32 and transformed data for charts.
// temperature/water_level/ammonia are null when that sensor's last reading
// was a failed-sensor sentinel (stored as NULL server-side) — render "--"
// and never treat null as 0.
export type SensorEntry = {
  device_id: string;
  temperature: number | null;
  water_level: number | null;
  ammonia: number | null;
  timestamp?: string;
  recv_at?: string;
};

// Optimized for Recharts; "name" is a formatted time label for the X-axis.
export type ChartPoint = {
  name: string;
  timestamp: string;
  temperature: number | null;     // null = sensor failure
  water_level: number | null;
  ammonia: number | null;
};

// Navigation types

export const VALID_MENU_KEYS = [
  "Dashboard",
  "Sensors",
  "Alerts",
  "Historical Data",
  "Analytics",
  "Activity Logs",
  "Settings",
  "Sensor Logs",
] as const;

export type MenuKey = typeof VALID_MENU_KEYS[number];

// Type guard for validating saved menu state from localStorage.
export function isValidMenuKey(value: string): value is MenuKey {
  return VALID_MENU_KEYS.includes(value as MenuKey);
}

// Log entry types

export type LogEntry = {
  id?: number;
  action: string;
  parameter: string;
  old_value: string | number;
  new_value: string | number;
  // Tank this entry belongs to (threshold alerts, resolves, disconnects,
  // per-tank settings changes). NULL = farm-wide/global row (also covers all
  // history that predates per-tank attribution).
  device_id?: string | null;
  timestamp?: string;
  ack_status?: string | null;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
};

// Sensor settings types

// Min/max acceptable ranges for each sensor parameter.
export type SensorSettings = {
  id?: number;
  temp_min: number;
  temp_max: number;
  water_level_min: number;
  water_level_max: number;
  ammonia_min: number;
  ammonia_max: number;
  updated_at?: string;
};

// Default safe ranges for crayfish aquaculture (used when no DB settings exist).
export const DEFAULT_SETTINGS: SensorSettings = {
  temp_min: 20.0,
  temp_max: 31.0,
  water_level_min: 10.0,
  water_level_max: 100.0,
  ammonia_min: 0.25,
  ammonia_max: 1.0,
};

// Per-tank threshold overrides (device_threshold_overrides, migration 012).
// A tank absent from the map inherits the global row entirely; a present tank
// overrides only the fields it defines. Layering: { ...global, ...override }.
export type DeviceThresholdOverrides = Record<string, Partial<SensorSettings>>;

// GET /settings/effective — global row + per-tank overrides in one call.
export type EffectiveThresholdsResponse = {
  global: SensorSettings;
  devices: DeviceThresholdOverrides;
};

// GET /settings/device/:id — effective thresholds + which fields are custom.
export type DeviceThresholdDetail = {
  device_id: string;
  tank_name: string | null;
  tank_location: string | null;
  global: SensorSettings;
  effective: SensorSettings;
  overridden: Record<string, boolean>;
  override: Partial<SensorSettings> | null;
};

// Merges a per-tank override onto the global row; null override = global.
export function mergeThresholds(
  base: SensorSettings | null,
  override?: Partial<SensorSettings> | null
): SensorSettings {
  return { ...(base ?? DEFAULT_SETTINGS), ...(override ?? {}) };
}

// Threshold configuration types

export type ThresholdRange = {
  min: number;
  max: number;
};

// Per-sensor config including display name, unit, range, color, and evaluation mode.
export type SensorThreshold = {
  name: string;
  unit: string;
  range: ThresholdRange;
  isMinOnly: boolean;
  color: string;
};

// Maps DB field names (temp_min/temp_max) to sensor keys (temperature/water_level).
export function getSettingsThresholds(settings: SensorSettings | null): Record<string, SensorThreshold> {
  const defaults = settings ?? DEFAULT_SETTINGS;
  return {
    temperature: {
      name: "Temperature",
      unit: "Â°C",
      range: { min: defaults.temp_min, max: defaults.temp_max },
      isMinOnly: false,
      color: "text-orange-500",
    },
    water_level: {
      name: "Water Level",
      unit: "%",
      range: { min: defaults.water_level_min, max: defaults.water_level_max },
      isMinOnly: false,
      color: "text-blue-500",
    },
    ammonia: {
      name: "Ammonia",
      unit: "ppm",
      range: { min: defaults.ammonia_min, max: defaults.ammonia_max },
      isMinOnly: false,
      color: "text-emerald-500",
    },
  };
}

// Device / tank types

// Fleet registry entries as returned by GET /devices, plus the live payload of
// each ESP32's GET /status endpoint (server -> device, health/diagnostics only).

export type DeviceEntry = {
  device_id: string;
  name: string | null;
  tank_name: string | null;
  tank_location: string | null;
  ip_address: string | null;
  is_active: boolean;
  last_seen: string | null;
  last_health_seen: string | null;
  online: boolean;
};

// Label for tank pickers (dropdowns, filter selects): friendly name first,
// with the raw device id appended when it differs — two tanks can share a
// display name (e.g. a renamed board), and the id is the only way to tell
// them apart in a list.
export function tankOptionLabel(
  device: Pick<DeviceEntry, "device_id" | "name" | "tank_name">
): string {
  const label = device.tank_name || device.name || device.device_id;
  return label !== device.device_id ? `${label} (${device.device_id})` : label;
}

export type DeviceStatus = {
  device_id: string;
  ip: string;
  uptime_ms: number;
  wifi_rssi: number;
  free_heap: number;
  temperature: number;
  water_level: number;
  ammonia: number;
};

// Freshest in-memory reading per tank, returned by GET /devices/latest. Values
// are null when the server has no reading for a tank yet (e.g. right after a
// backend restart before that tank's first POST).
export type DeviceLiveReading = {
  device_id: string;
  recv_at: string | null;
  temperature: number | null;
  water_level: number | null;
  ammonia: number | null;
};

// Threshold status evaluation

export type ThresholdStatus = "good" | "warning" | "critical";

// Evaluates a value against its range; 15% deviation beyond the range = critical.
// IMPORTANT: must stay in sync with server.cjs getThresholdStatus() — changes
// affect Alerts page severity and the threshold cross-check test
// (src/types/threshold.test.cjs). A null (failed sensor, no reading) can't
// breach a threshold — mirroring the server's sentinel skip — because
// Number(null) === 0 would otherwise raise a false "critically low" alert.
export function getThresholdStatus(
  value: number | null,
  range: ThresholdRange,
  isMinOnly: boolean
): ThresholdStatus {
  if (value === null || value === undefined) return "good";
  const min = Number(range.min);
  const max = Number(range.max);
  const val = Number(value);

  const rangeSize = max - min;
  const criticalMargin = rangeSize * 0.15;

  if (isMinOnly) {
    // Min-only threshold: only values below min are breaches, same 15% margin.
    if (val < min) {
      const deviation = min - val;
      return deviation >= criticalMargin ? "critical" : "warning";
    }
    return "good";
  }

  if (val < min) {
    const deviation = min - val;
    return deviation >= criticalMargin ? "critical" : "warning";
  }
  if (val > max) {
    const deviation = val - max;
    return deviation >= criticalMargin ? "critical" : "warning";
  }

  return "good";
}

// Alert types

export type AlertSeverity = "info" | "warning" | "critical";

// Determines alert severity from log entry and configured thresholds.
export function parseAlertSeverity(log: LogEntry, settings?: SensorSettings | null): AlertSeverity {
  if (log.action !== "Alert") return "info";

  const key = DISPLAY_TO_SENSOR_KEY[log.parameter];
  const val = Number(log.new_value);
  if (!key || !Number.isFinite(val)) return "warning";

  const config = getSettingsThresholds(settings ?? null)[key];
  if (!config) return "warning";

  return getThresholdStatus(val, config.range, config.isMinOnly) === "critical" ? "critical" : "warning";
}

// API configuration

const DEFAULT_API_BASE = "http://localhost:3000";

function getApiBase(): string {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return import.meta.env.VITE_API_BASE || DEFAULT_API_BASE;
  }
  return DEFAULT_API_BASE;
}

// Sensor key mappings

export const SENSOR_KEY_TO_DISPLAY: Record<string, string> = {
  temperature: "Temperature",
  water_level: "Water Level",
  ammonia: "Ammonia",
};

export const DISPLAY_TO_SENSOR_KEY: Record<string, string> = {
  "Temperature": "temperature",
  "Water Level": "water_level",
  "Ammonia": "ammonia",
};

export const API_BASE = getApiBase();

// Activity log types

export type ActivityLog = {
  id?: number;
  user_name: string;
  action_type: string;
  description: string;
  module: string;
  timestamp?: string;
};

export type ActivityActionType =
  | "navigation"
  | "button_click"
  | "form_submit"
  | "settings_change"
  | "device_connect"
  | "device_disconnect"
  | "system_event"
  | "login"
  | "logout";

// Input for creating activity log entries; user_name defaults to "Admin" server-side.
export interface ActivityLogEntry {
  user_name?: string;
  action_type: ActivityActionType;
  description: string;
  module: string;
}

// Authentication types

// "admin" = full access, "user" = read-only dashboards/logs.
export type UserRole = "user" | "admin";

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  name: string;
  /** True when this account is the system owner (root admin). */
  owner?: boolean;
  protected?: boolean;
}

// Response from POST /auth/login.
export interface AuthResponse {
  message: string;
  user: AuthUser;
  token: string;
}

// Weekly report types

export type WeeklyReportDaily = {
  date: string;
  temp_avg: number;
  temp_min: number;
  temp_max: number;
  water_avg: number;
  water_min: number;
  water_max: number;
  ammonia_avg: number;
  ammonia_min: number;
  ammonia_max: number;
  readings: number;
  alerts: number;
};

export type WeeklyReport = {
  // "hour" | "day" when produced by /report/range; undefined for /report/weekly.
  bucket?: "hour" | "day";
  period: { start: string; end: string };
  summary: {
    temp_avg: number;
    temp_min: number;
    temp_max: number;
    water_avg: number;
    water_min: number;
    water_max: number;
    ammonia_avg: number;
    ammonia_min: number;
    ammonia_max: number;
    total_readings: number;
  };
  daily: WeeklyReportDaily[];
  alerts: {
    total: number;
    by_parameter: Record<string, number>;
    by_action: Record<string, number>;
  };
};

// Analytics types

export type AnalyticsParamStats = { avg: number; min: number; max: number };
export type AnalyticsTrend = { current_avg: number; previous_avg: number; change_pct: number; direction: "up" | "down" | "stable" };

export type AnalyticsOverview = {
  period: { start: string; end: string };
  days: number;
  summary: {
    temperature: AnalyticsParamStats;
    water_level: AnalyticsParamStats;
    ammonia: AnalyticsParamStats;
    total_readings: number;
  };
  trends: {
    temperature: AnalyticsTrend;
    water_level: AnalyticsTrend;
    ammonia: AnalyticsTrend;
  };
  alerts: {
    total: number;
    resolved: number;
    by_parameter: Record<string, number>;
    by_action: Record<string, number>;
  };
  uptime: {
    device_offline: boolean;
    last_reading: string | null;
    readings: number;
    gap_events: number;
  };
};

export type AnalyticsDailyEntry = {
  date: string;
  temp_avg: number;
  water_avg: number;
  ammonia_avg: number;
  readings: number;
  alerts: number;
};

export type AnalyticsDailyResponse = {
  period: { start: string; end: string };
  days: number;
  daily: AnalyticsDailyEntry[];
};

export type InsightLevel = "info" | "warning" | "critical";

export type Insight = {
  level: InsightLevel;
  area: string;
  title: string;
  message: string;
  action?: string;
};

export type AnalyticsInsightsResponse = {
  period: { start: string; end: string };
  days: number;
  insights: Insight[];
};
