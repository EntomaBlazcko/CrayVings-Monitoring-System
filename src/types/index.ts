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
  | "Settings";

export const API_BASE =
  import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "http://192.168.1.20:3000";
