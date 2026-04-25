import { createContext, useContext } from "react";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings, ActivityLog, ActivityActionType } from "../types";

export type ConnectionStatus = "online" | "offline" | "connecting" | "unknown";

export interface SensorDataContextValue {
  data: SensorEntry | null;
  history: ChartPoint[];
  loading: boolean;
  error: string | null;
  connectionStatus: ConnectionStatus;
  lastUpdate: Date | null;
  consecutiveFailures: number;
  refetch: () => void;
}

export interface SensorSettingsContextValue {
  settings: SensorSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  saveError: string | null;
  refetchSettings: () => void;
  saveSettings: (settings: Partial<SensorSettings>) => Promise<void>;
  settingsSaved: boolean;
  settingsSaving: boolean;
}

export interface LogsContextValue {
  logs: LogEntry[];
  logsLoading: boolean;
  logsError: string | null;
  refetchLogs: () => void;
  logsPage: number;
  logsTotal: number;
  setLogsPage: (page: number) => void;
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

export const ActivityLogsContext = createContext<ActivityLogsContextValue | null>(null);

export const SensorDataContext = createContext<SensorDataContextValue | null>(null);
export const SensorSettingsContext = createContext<SensorSettingsContextValue | null>(null);
export const LogsContext = createContext<LogsContextValue | null>(null);

export function useSensorData(): SensorDataContextValue {
  const context = useContext(SensorDataContext);
  if (!context) {
    throw new Error("useSensorData must be used within a SensorProvider");
  }
  return context;
}

export function useSensorSettings(): SensorSettingsContextValue {
  const context = useContext(SensorSettingsContext);
  if (!context) {
    throw new Error("useSensorSettings must be used within a SensorProvider");
  }
  return context;
}

export function useSystemLogs(): LogsContextValue {
  const context = useContext(LogsContext);
  if (!context) {
    throw new Error("useSystemLogs must be used within a SensorProvider");
  }
  return context;
}

export function useActivityLogs(): ActivityLogsContextValue {
  const context = useContext(ActivityLogsContext);
  if (!context) {
    throw new Error("useActivityLogs must be used within a SensorProvider");
  }
  return context;
}