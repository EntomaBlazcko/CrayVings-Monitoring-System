export type SensorEntry = {
  _id?: string;
  device_id: string;
  temperature: number;
  water_level: number;
  ph: number;
  dissolved_oxygen: number;
  ammonia: number;
  timestamp?: string;
};

export type ChartPoint = {
  name: string;
  temperature: number;
  water_level: number;
  ph: number;
  dissolved_oxygen: number;
  ammonia: number;
};

export const VALID_MENU_KEYS = [
  "Home",
  "Dashboard",
  "Sensors",
  "Alerts",
  "Historical Data",
  "Activity Logs",
  "Settings",
  "Logs",
] as const;

export type MenuKey = typeof VALID_MENU_KEYS[number];

export function isValidMenuKey(value: string): value is MenuKey {
  return VALID_MENU_KEYS.includes(value as MenuKey);
}

export type LogEntry = {
  id?: number;
  action: string;
  parameter: string;
  old_value: string | number;
  new_value: string | number;
  timestamp?: string;
};

export type SensorSettings = {
  id?: number;
  temp_min: number;
  temp_max: number;
  ph_min: number;
  ph_max: number;
  do_min: number;
  do_max: number;
  water_level_min: number;
  water_level_max: number;
  ammonia_min: number;
  ammonia_max: number;
  updated_at?: string;
};

export const DEFAULT_SETTINGS: SensorSettings = {
  temp_min: 20.0,
  temp_max: 31.0,
  ph_min: 6.5,
  ph_max: 8.5,
  do_min: 5.0,
  do_max: 10.0,
  water_level_min: 10.0,
  water_level_max: 100.0,
  ammonia_min: 0.0,
  ammonia_max: 0.5,
};

export type ThresholdRange = {
  min: number;
  max: number;
};

export type SensorThreshold = {
  name: string;
  unit: string;
  range: ThresholdRange;
  isMinOnly: boolean;
  color: string;
};

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
    ph: {
      name: "pH Level",
      unit: "",
      range: { min: defaults.ph_min, max: defaults.ph_max },
      isMinOnly: false,
      color: "text-purple-500",
    },
    dissolved_oxygen: {
      name: "Dissolved Oxygen",
      unit: "mg/L",
      range: { min: defaults.do_min, max: defaults.do_max },
      isMinOnly: false,
      color: "text-sky-500",
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
      color: "text-amber-500",
    },
  };
}

export type ThresholdStatus = "good" | "warning" | "critical";

export function getThresholdStatus(
  value: number,
  range: ThresholdRange,
  isMinOnly: boolean
): ThresholdStatus {
  if (isMinOnly) {
    return value >= range.min ? "good" : "warning";
  }
  if (value < range.min || value > range.max) return "warning";
  return "good";
}

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertEntry extends LogEntry {
  severity: AlertSeverity;
}

export function parseAlertSeverity(log: LogEntry): AlertSeverity {
  if (log.action !== "Alert") return "info";
  
  const param = log.parameter;
  const val = Number(log.new_value);
  
  if (param === "Temperature") {
    return val > 35 || val < 15 ? "critical" : "warning";
  } else if (param === "pH Level") {
    return val > 9 || val < 5 ? "critical" : "warning";
  } else if (param === "Dissolved Oxygen" || param === "Ammonia") {
    return "critical";
  }
  return "warning";
}

export const API_BASE = "http://localhost:3000";

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

export interface ActivityLogEntry {
  user_name?: string;
  action_type: ActivityActionType;
  description: string;
  module: string;
}