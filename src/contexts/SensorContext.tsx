import { createContext } from "react";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings, ActivityLog, ActivityActionType, DeviceEntry, DeviceLiveReading, DeviceThresholdOverrides, SensorThreshold } from "../types";

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
  latestByTank: Record<string, DeviceLiveReading>;  // freshest reading per tank (same 5s poll)
  selectedDeviceId: string | null;     // currently viewed tank
  setSelectedDeviceId: (deviceId: string | null) => void;
  refetch: () => void;
}

export interface SensorSettingsContextValue {
  settings: SensorSettings | null;                      // global (farm default) row
  deviceOverrides: DeviceThresholdOverrides;             // tanks with per-threshold overrides
  settingsFor: (deviceId?: string | null) => SensorSettings | null;              // merged effective row
  thresholdsFor: (deviceId?: string | null) => Record<string, SensorThreshold>;   // stable per-tank threshold map
  settingsLoading: boolean;
  settingsError: string | null;
  saveError: string | null;
  refetchSettings: () => void;
  saveSettings: (settings: Partial<SensorSettings>) => Promise<void>;
  saveDeviceThresholds: (deviceId: string, override: Partial<SensorSettings>) => Promise<void>;
  clearDeviceThresholds: (deviceId: string) => Promise<void>;
  settingsSaved: boolean;              // true briefly after successful save
  settingsSaving: boolean;
}

// How the Alerts/Logs pages scope their list:
//   "follow" -> the globally selected tank (default; switching tanks in the
//               header instantly re-scopes both pages),
//   "all"    -> every tank incl. farm-wide rows,
//   "<id>"   -> one specific tank regardless of the global selection.
export type LogsDeviceMode = "follow" | "all" | string;

export interface LogsContextValue {
  logs: LogEntry[];
  logsLoading: boolean;
  logsError: string | null;
  refetchLogs: () => void;
  logsPage: number;
  logsTotal: number;
  logsCounts: Record<string, number>;  // per-action counts from API (device-filter aware)
  setLogsPage: (page: number) => void;
  logsActionFilter: string;
  setLogsActionFilter: (filter: string) => void;
  logsParameterFilter: string;
  setLogsParameterFilter: (filter: string) => void;
  logsDeviceMode: LogsDeviceMode;
  setLogsDeviceMode: (mode: LogsDeviceMode) => void;
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
