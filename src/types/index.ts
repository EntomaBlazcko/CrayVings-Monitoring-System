// =============================================================================
// FILE: src/types/index.ts
// =============================================================================
// PURPOSE: Central TypeScript type definitions for the CRAYvings Monitoring System.
//
// This file defines all shared types, interfaces, constants, and utility functions
// used across the frontend. It serves as the single source of truth for:
//   - Data shapes (SensorEntry, ChartPoint, LogEntry, etc.)
//   - Configuration constants (DEFAULT_SETTINGS, API_BASE)
//   - Navigation types (MenuKey, validation)
//   - Threshold evaluation logic (frontend duplicate of server logic)
//   - Authentication types (AuthUser, AuthResponse)
//   - Activity logging types (ActivityLog, ActivityActionType)
//
// Having types centralized ensures type safety across all components,
// hooks, API calls, and context providers.
// =============================================================================

// ========================
// SENSOR DATA TYPES
// ========================
// These types represent the raw data received from the ESP32 device
// and the transformed data used for chart rendering.

/**
 * Raw sensor reading as stored in the PostgreSQL "sensors" table.
 * Represents a single data point from the ESP32 device.
 * The _id field is optional (used if MongoDB was considered, but PG uses numeric id).
 */
export type SensorEntry = {
  _id?: string;
  device_id: string;       // ESP32 device identifier
  temperature: number;     // Water temperature in Celsius
  water_level: number;     // Water level as percentage
  ammonia: number;         // Ammonia gas concentration in ppm (NH3, MQ-137)
  timestamp?: string;      // ISO 8601 timestamp of the reading
};

/**
 * Transformed sensor data point optimized for Recharts line charts.
 * The "name" field is a formatted time string for the X-axis display.
 * Created by the API client's fetchSensorHistory function.
 */
export type ChartPoint = {
  name: string;            // Formatted time label (e.g., "02:30 PM")
  timestamp: string;       // ISO 8601 timestamp
  temperature: number | null;     // Temperature value for charting (null = sensor failure)
  water_level: number | null;     // Water level value for charting (null = sensor failure)
  ammonia: number | null;         // Ammonia value for charting (null = sensor failure)
};

// ========================
// NAVIGATION TYPES
// ========================
// Defines valid page/menu keys used throughout the app for routing
// and sidebar navigation.

/**
 * Array of all valid menu/page keys used for navigation.
 * Marked as const to create a readonly tuple for type inference.
 */
export const VALID_MENU_KEYS = [
  "Home",
  "Dashboard",
  "Sensors",
  "Alerts",
  "Historical Data",
  "Activity Logs",
  "Settings",
  "Sensor Logs",
] as const;

/**
 * Union type of all valid menu keys.
 * Automatically derived from VALID_MENU_KEYS array.
 * Any new page added to the app must be included in VALID_MENU_KEYS.
 */
export type MenuKey = typeof VALID_MENU_KEYS[number];

/**
 * Type guard function to validate if a string is a valid MenuKey.
 * Used when restoring saved menu state from localStorage.
 */
export function isValidMenuKey(value: string): value is MenuKey {
  return VALID_MENU_KEYS.includes(value as MenuKey);
}

// ========================
// LOG ENTRY TYPES
// ========================

/**
 * A system log entry from the "system_logs" database table.
 * Records sensor alerts, setting changes, and system events.
 * Used by the AlertsPage and LogsPage.
 */
export type LogEntry = {
  id?: number;
  action: string;              // e.g., "Alert", "Change", "Device Disconnect"
  parameter: string;           // e.g., "Temperature", "Water Level"
  old_value: string | number;  // Previous value or threshold direction ("Low"/"High")
  new_value: string | number;  // New sensor reading value
  timestamp?: string;          // ISO 8601 timestamp
};

// ========================
// SENSOR SETTINGS TYPES
// ========================
// Threshold configuration that determines when alerts are triggered.

/**
 * Sensor threshold settings stored in the "sensor_settings" table.
 * Defines the acceptable min/max range for each sensor parameter.
 * Values outside these ranges trigger warning or critical alerts.
 */
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

/**
 * Default threshold values used when no settings exist in the database.
 * These represent safe ranges for crayfish aquaculture.
 * Temperature: 20-31°C, Water Level: 10-100%, Ammonia: 0-25 ppm
 */
export const DEFAULT_SETTINGS: SensorSettings = {
  temp_min:20.0,
  temp_max:31.0,
  water_level_min:10.0,
  water_level_max:100.0,
  ammonia_min:0.25,
  ammonia_max:1.0,
};

// ========================
// THRESHOLD CONFIGURATION TYPES
// ========================
// Used to configure how each sensor is displayed and evaluated in the UI.

/**
 * Simple min/max range for a single sensor parameter.
 */
export type ThresholdRange = {
  min: number;
  max: number;
};

/**
 * Complete threshold configuration for a sensor.
 * Includes display name, unit, range, color, and evaluation mode.
 * Generated by getSettingsThresholds() from SensorSettings.
 */
export type SensorThreshold = {
  name: string;              // Display name (e.g., "Temperature")
  unit: string;              // Unit symbol (e.g., "°C", "%")
  range: ThresholdRange;     // Min/max acceptable values
  isMinOnly: boolean;        // If true, only checks against minimum
  color: string;             // Tailwind CSS color class for UI
};

/**
 * Converts SensorSettings into a map of SensorThreshold configurations.
 * Maps database field names (temp_min/temp_max) to sensor keys
 * (temperature/water_level) used throughout the frontend.
 */
export function getSettingsThresholds(settings: SensorSettings | null): Record<string, SensorThreshold> {
  const defaults = settings ?? DEFAULT_SETTINGS;
  return {
    temperature: {
      name: "Temperature",
      unit: "°C",
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

// ========================
// THRESHOLD STATUS EVALUATION
// ========================
// Frontend duplicate of the server's getThresholdStatus() function.
// Uses the same algorithm (15% margin for critical vs warning).

/**
 * Possible threshold status values.
 * "good" = within range, "warning" = slightly outside, "critical" = far outside
 */
export type ThresholdStatus = "good" | "warning" | "critical";

/**
 * Evaluates a sensor value against its threshold range on the frontend.
 * Uses the same 15% margin logic as the server's getThresholdStatus().
 * @param value - Current sensor reading
 * @param range - Min/max acceptable range
 * @param isMinOnly - If true, only checks against minimum (not currently used)
 * @returns "good", "warning", or "critical"
 */
export function getThresholdStatus(
  value: number,
  range: ThresholdRange,
  isMinOnly: boolean
): ThresholdStatus {
  const min = Number(range.min);
  const max = Number(range.max);
  const val = Number(value);

  if (isMinOnly) {
    return val >= min ? "good" : "warning";
  }
  
  const rangeSize = max - min;
  const criticalMargin = rangeSize * 0.15;
  
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

// ========================
// ALERT TYPES
// ========================

/**
 * Severity levels for alert display in the UI.
 * "critical" = red/danger, "warning" = orange/caution, "info" = blue/neutral
 */
export type AlertSeverity = "info" | "warning" | "critical";

/**
 * Determines the severity of an alert based on sensor parameter and value.
 * Uses the user-configured threshold ranges from SensorSettings:
 *   - Critical when the value deviates from the configured range by 15% or more
 *   - Warning when it is only slightly outside
 *   - Falls back to DEFAULT_SETTINGS when no settings are available
 */
export function parseAlertSeverity(log: LogEntry, settings?: SensorSettings | null): AlertSeverity {
  if (log.action !== "Alert") return "info";

  const key = DISPLAY_TO_SENSOR_KEY[log.parameter];
  const val = Number(log.new_value);
  if (!key || !Number.isFinite(val)) return "warning";

  const config = getSettingsThresholds(settings ?? null)[key];
  if (!config) return "warning";

  return getThresholdStatus(val, config.range, config.isMinOnly) === "critical" ? "critical" : "warning";
}

// ========================
// API CONFIGURATION
// ========================
// Determines the backend API base URL for all frontend HTTP requests.

/**
 * Default API base URL for development (local server).
 * In production, this is overridden by the VITE_API_BASE environment variable.
 */
const DEFAULT_API_BASE = "http://localhost:3000";

/**
 * Returns the API base URL from environment variables or falls back to default.
 * Uses import.meta.env for Vite environment variable access.
 * This allows deploying the frontend to different environments without code changes.
 */
export function getApiBase(): string {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return import.meta.env.VITE_API_BASE || DEFAULT_API_BASE;
  }
  return DEFAULT_API_BASE;
}

// ========================
// SENSOR KEY MAPPINGS
// ========================
// Bidirectional mappings between internal sensor keys and display names.
// Used to convert between database/API keys and user-facing labels.

/**
 * Maps internal sensor keys to human-readable display names.
 * e.g., "temperature" -> "Temperature", "water_level" -> "Water Level"
 */
export const SENSOR_KEY_TO_DISPLAY: Record<string, string> = {
  temperature: "Temperature",
  water_level: "Water Level",
  ammonia: "Ammonia",
};

/**
 * Maps display names back to internal sensor keys.
 * e.g., "Temperature" -> "temperature", "Water Level" -> "water_level"
 */
export const DISPLAY_TO_SENSOR_KEY: Record<string, string> = {
  "Temperature": "temperature",
  "Water Level": "water_level",
  "Ammonia": "ammonia",
};

/**
 * Computed API base URL constant.
 * Evaluated at module load time, used by the API client for all requests.
 */
export const API_BASE = getApiBase();

// ========================
// ACTIVITY LOG TYPES
// ========================
// Types for tracking user interactions and system events.

/**
 * An activity log entry from the "activity_logs" database table.
 * Records user navigation, settings changes, logins, etc.
 */
export type ActivityLog = {
  id?: number;
  user_name: string;         // User who performed the action
  action_type: string;       // Type of action (see ActivityActionType)
  description: string;       // Human-readable description
  module: string;            // Module/page where the action occurred
  timestamp?: string;        // ISO 8601 timestamp
};

/**
 * Union type of all possible activity action types.
 * Used for type-safe activity logging and filtering.
 */
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

/**
 * Array of all valid activity action types.
 * Used for populating filter dropdowns in the Activity Logs page.
 */
export const ACTIVITY_ACTION_TYPES: ActivityActionType[] = [
  "navigation",
  "button_click",
  "form_submit",
  "settings_change",
  "device_connect",
  "device_disconnect",
  "system_event",
  "login",
  "logout",
];

/**
 * Input type for creating a new activity log entry.
 * user_name is optional (defaults to "Admin" on the server).
 */
export interface ActivityLogEntry {
  user_name?: string;
  action_type: ActivityActionType;
  description: string;
  module: string;
}

// ========================
// AUTHENTICATION TYPES
// ========================

/**
 * Possible user roles in the system.
 * "admin" = full access to settings and user management
 * "user" = read-only access to dashboards and logs
 */
export type UserRole = "user" | "admin";

/**
 * Authenticated user information returned after login.
 * Stored in localStorage for session persistence.
 */
export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  name: string;
}

/**
 * Response structure from the POST /auth/login endpoint.
 * Contains the authenticated user object and session token.
 */
export interface AuthResponse {
  message: string;
  user: AuthUser;
  token: string;
}

// ========================
// WEEKLY REPORT TYPES
// ========================

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
