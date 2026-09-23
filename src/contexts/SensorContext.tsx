import { createContext } from "react";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings, ActivityLog, ActivityActionType, DeviceEntry } from "../types";

// "online" = heartbeat within 30s, "offline" = no heartbeat for 30+s,
// "connecting" = waiting for first data, "unknown" = never received data.
export type ConnectionStatus = "online" | "offline" | "connecting" | "unknown";

export interface SensorDataContextValue {
  latestReading: SensorEntry | null;
  history: ChartPoint[];
  loading: boolean;
  error: string | null;
  connectionStatus: ConnectionStatus;
  lastUpdate: Date | null;
  consecutiveFailures: number;         // consecutive failed polls
  historyStale: boolean;               // true if last history fetch failed
  historyLastUpdated: Date | null;
  devices: DeviceEntry[];              // fleet registry, polled every 5s
  devicesLoading: boolean;
  selectedDeviceId: string | null;     // currently viewed tank
  setSelectedDeviceId: (deviceId: string | null) => void;
  refetch: () => void;
}

export interface SensorSettingsContextValue {
  settings: SensorSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  saveError: string | null;
  refetchSettings: () => void;
  saveSettings: (settings: Partial<SensorSettings>) => Promise<void>;
  settingsSaved: boolean;              // true briefly after successful save
  settingsSaving: boolean;
}

export interface LogsContextValue {
  logs: LogEntry[];
  logsLoading: boolean;
  logsError: string | null;
  refetchLogs: () => void;
  logsPage: number;
  logsTotal: number;
  logsCounts: Record<string, number>;  // per-action counts from API
  setLogsPage: (page: number) => void;
  logsActionFilter: string;
  setLogsActionFilter: (filter: string) => void;
  logsParameterFilter: string;
  setLogsParameterFilter: (filter: string) => void;
}

export interface ActivityLogsContextValue {
  activityLogs: ActivityLog[];
  activityLogsLoading: boolean;
  activityLogsError: string | null;
  activityLogsPage: number;
  activityLogsTotal: number;
  activityLogsTotalPages: number;
  activitySearch: string;
  activitySortBy: "newest" | "oldest";
  activityActionFilter: string;
  setActivityLogsPage: (page: number) => void;
  setActivitySearch: (search: string) => void;
  setActivitySortBy: (sort: "newest" | "oldest") => void;
  setActivityActionFilter: (filter: string) => void;
  refetchActivityLogs: () => void;
  logActivity: (actionType: ActivityActionType, description: string, module: string) => void;
}

// Contexts are null until SensorProvider mounts; consumer hooks live in
// hooks/useSensors.ts and throw when used outside the provider.
export const ActivityLogsContext = createContext<ActivityLogsContextValue | null>(null);
export const SensorDataContext = createContext<SensorDataContextValue | null>(null);
export const SensorSettingsContext = createContext<SensorSettingsContextValue | null>(null);
export const LogsContext = createContext<LogsContextValue | null>(null);
