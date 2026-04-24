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

export type MenuKey =
  | "Home"
  | "Dashboard"
  | "Sensors"
  | "Alerts"
  | "Historical Data"
  | "Settings"
  | "Logs";

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

export const API_BASE =
  import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "http://localhost:3000";

export const LOGS_ENDPOINT = `${API_BASE}/system-logs`;
export const SETTINGS_ENDPOINT = `${API_BASE}/settings`;
