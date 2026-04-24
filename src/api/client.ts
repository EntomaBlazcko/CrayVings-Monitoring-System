import axios, { isAxiosError } from "axios";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings } from "../types";
import { API_BASE } from "../types";

const client = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: {
    "Content-Type": "application/json",
  },
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error("API Error:", error.message);
    return Promise.reject(error);
  }
);

export async function fetchLatestSensor(): Promise<SensorEntry | null> {
  try {
    const response = await client.get<SensorEntry>("/sensor/latest");
    return response.data;
  } catch (error) {
    if (isAxiosError(error)) {
      if (error.response?.status === 404) {
        return null;
      }
    }
    throw error;
  }
}

export async function fetchSensorHistory(limit = 50): Promise<ChartPoint[]> {
  const response = await client.get<SensorEntry[]>("/sensor", {
    params: { limit },
  });
  return (response.data || [])
    .slice()
    .reverse()
    .map((item) => ({
      name: item.timestamp
        ? new Date(item.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "--:--",
      temperature: item.temperature ?? 0,
      water_level: item.water_level ?? 0,
      ph: item.ph ?? 0,
      dissolved_oxygen: item.dissolved_oxygen ?? 0,
      ammonia: item.ammonia ?? 0,
    }));
}

export async function fetchLogs(): Promise<LogEntry[]> {
  const response = await client.get<LogEntry[]>("/system-logs");
  return response.data || [];
}

export async function fetchSettings(): Promise<SensorSettings> {
  const response = await client.get<SensorSettings>("/settings");
  return response.data;
}

export async function saveSettings(settings: Partial<SensorSettings>): Promise<void> {
  await client.post("/settings", settings);
}

export async function createLog(
  action: string,
  parameter: string,
  oldValue: string | number,
  newValue: string | number
): Promise<LogEntry> {
  const response = await client.post<{ data: LogEntry }>("/logs", {
    action,
    parameter,
    old_value: oldValue,
    new_value: newValue,
  });
  return response.data.data;
}

export async function checkHealth(): Promise<{ status: string; serverTime: string }> {
  const response = await client.get("/health");
  return response.data;
}

export default client;