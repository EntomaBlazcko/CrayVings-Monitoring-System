// =============================================================================
// FILE: src/contexts/SensorContext.tsx
// =============================================================================
// PURPOSE: Context interfaces and custom hooks for sensor data, settings,
//          system logs, and activity logs.
//
// This file defines:
//   - TypeScript interfaces for each context's value shape
//   - React Context objects (created but values provided by SensorProvider)
//   - Custom hooks (useSensorData, useSensorSettings, useSystemLogs, useActivityLogs)
//     that consume the contexts with proper error handling
//
// CONTEXT ARCHITECTURE:
//   This file creates the context objects and hooks, but the actual data
//   is provided by SensorProvider.tsx. This separation of concerns allows:
//   - Clean type definitions in one file
//   - State management logic in another file
//   - Easy consumption via custom hooks from any component
//
// THE FOUR CONTEXTS:
//   1. SensorDataContext    - Live sensor data, connection status, history
//   2. SensorSettingsContext - Threshold settings and save operations
//   3. LogsContext           - Paginated system logs
//   4. ActivityLogsContext   - User activity tracking with search/filter
// =============================================================================

import { createContext, useContext } from "react";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings, ActivityLog, ActivityActionType } from "../types";

// ========================
// CONNECTION STATUS TYPE
// ========================
/**
 * Represents the ESP32 device connection state.
 *   - "online":     Receiving data within the last 15 seconds
 *   - "offline":    No data received for 15+ seconds
 *   - "connecting":  Loading or waiting for initial data
 *   - "unknown":    No data has ever been received
 */
export type ConnectionStatus = "online" | "offline" | "connecting" | "unknown";

// ========================
// SENSOR DATA CONTEXT
// ========================
/**
 * Context value shape for real-time sensor data.
 * Contains the latest reading, historical chart data, and connection status.
 */
export interface SensorDataContextValue {
  data: SensorEntry | null;            // Latest sensor reading
  history: ChartPoint[];               // Historical data for charts
  loading: boolean;                    // True during initial data fetch
  error: string | null;                // Error message if fetch failed
  connectionStatus: ConnectionStatus;  // ESP32 device connection state
  lastUpdate: Date | null;             // Timestamp of last successful fetch
  consecutiveFailures: number;         // Count of consecutive failed polls
  refetch: () => void;                 // Manual trigger to re-fetch data
}

// ========================
// SENSOR SETTINGS CONTEXT
// ========================
/**
 * Context value shape for sensor threshold settings.
 * Contains current settings and save/reset operations.
 */
export interface SensorSettingsContextValue {
  settings: SensorSettings | null;     // Current threshold settings
  settingsLoading: boolean;            // True during settings fetch
  settingsError: string | null;        // Error message if fetch failed
  saveError: string | null;            // Error message if save failed
  refetchSettings: () => void;         // Manual trigger to re-fetch settings
  saveSettings: (settings: Partial<SensorSettings>) => Promise<void>;  // Save updated settings
  settingsSaved: boolean;              // True briefly after successful save
  settingsSaving: boolean;             // True during save operation
}

// ========================
// SYSTEM LOGS CONTEXT
// ========================
/**
 * Context value shape for system log entries.
 * Contains paginated logs, page navigation, and per-action counts.
 */
export interface LogsContextValue {
  logs: LogEntry[];                    // Current page of log entries
  logsLoading: boolean;                // True during log fetch
  logsError: string | null;            // Error message if fetch failed
  refetchLogs: () => void;             // Manual trigger to re-fetch logs
  logsPage: number;                    // Current page number
  logsTotal: number;                   // Total number of log entries
  logsCounts: Record<string, number>;  // Per-action counts from API
  setLogsPage: (page: number) => void; // Navigate to a specific page
}

// ========================
// ACTIVITY LOGS CONTEXT
// ========================
/**
 * Context value shape for user activity logs.
 * Contains paginated activity data with search, filter, and sort controls.
 */
export interface ActivityLogsContextValue {
  activityLogs: ActivityLog[];             // Current page of activity entries
  activityLogsLoading: boolean;            // True during fetch
  activityLogsError: string | null;        // Error message if fetch failed
  activityLogsPage: number;                // Current page number
  activityLogsTotal: number;               // Total number of entries
  activityLogsTotalPages: number;          // Total number of pages
  activitySearch: string;                  // Current search query
  activitySortBy: "newest" | "oldest";     // Current sort order
  activityActionFilter: string;            // Current action type filter
  setActivityLogsPage: (page: number) => void;
  setActivitySearch: (search: string) => void;
  setActivitySortBy: (sort: "newest" | "oldest") => void;
  setActivityActionFilter: (filter: string) => void;
  refetchActivityLogs: () => void;         // Manual trigger to re-fetch
  logActivity: (actionType: ActivityActionType, description: string, module: string) => void;
}

// ========================
// CONTEXT OBJECTS
// ========================
// Create React Context objects with null defaults.
// SensorProvider.tsx provides the actual values.

export const ActivityLogsContext = createContext<ActivityLogsContextValue | null>(null);

export const SensorDataContext = createContext<SensorDataContextValue | null>(null);
export const SensorSettingsContext = createContext<SensorSettingsContextValue | null>(null);
export const LogsContext = createContext<LogsContextValue | null>(null);

// ========================
// CUSTOM HOOKS
// ========================
// These hooks consume their respective contexts and throw if used outside
// the SensorProvider. This catches developer errors early.

/**
 * Hook to access real-time sensor data and connection status.
 * Must be used within a SensorProvider.
 */
export function useSensorData(): SensorDataContextValue {
  const context = useContext(SensorDataContext);
  if (!context) {
    throw new Error("useSensorData must be used within a SensorProvider");
  }
  return context;
}

/**
 * Hook to access and modify sensor threshold settings.
 * Must be used within a SensorProvider.
 */
export function useSensorSettings(): SensorSettingsContextValue {
  const context = useContext(SensorSettingsContext);
  if (!context) {
    throw new Error("useSensorSettings must be used within a SensorProvider");
  }
  return context;
}

/**
 * Hook to access paginated system logs.
 * Must be used within a SensorProvider.
 */
export function useSystemLogs(): LogsContextValue {
  const context = useContext(LogsContext);
  if (!context) {
    throw new Error("useSystemLogs must be used within a SensorProvider");
  }
  return context;
}

/**
 * Hook to access user activity logs with search/filter/sort controls.
 * Must be used within a SensorProvider.
 */
export function useActivityLogs(): ActivityLogsContextValue {
  const context = useContext(ActivityLogsContext);
  if (!context) {
    throw new Error("useActivityLogs must be used within a SensorProvider");
  }
  return context;
}
