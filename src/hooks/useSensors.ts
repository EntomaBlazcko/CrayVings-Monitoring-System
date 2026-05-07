// =============================================================================
// FILE: src/hooks/useSensors.ts
// =============================================================================
// PURPOSE: Consolidated hooks for accessing all sensor-related context data.
//
// This file provides convenience hooks that combine multiple context consumers:
//   - useSensors(): Returns ALL context data in one object (sensor data, settings,
//                   logs, activity logs) - useful for pages that need everything
//   - useSensorData(): Access just the sensor data context
//   - useSensorSettings(): Access just the settings context
//   - useSystemLogs(): Access just the system logs context
//   - useActivityLogs(): Access just the activity logs context
//   - useConnectionStatus(): Access just connection-related fields
//   - useActivityLogger(): Access just the logActivity function
//
// All hooks must be used within a SensorProvider.
//
// DESIGN NOTE:
//   useSensors() is a "mega-hook" that combines all contexts. This is convenient
//   for pages like HomePage that need data from multiple contexts, but individual
//   hooks should be preferred when only specific data is needed (better performance).
// =============================================================================

import { useContext } from "react";
import { SensorDataContext, SensorSettingsContext, LogsContext, ActivityLogsContext } from "../contexts/SensorContext";

/**
 * Mega-hook that returns all sensor-related context data in a single object.
 * Convenience method for components that need access to multiple data sources.
 * @throws Error if used outside SensorProvider
 */
export function useSensors() {
  const dataContext = useContext(SensorDataContext);
  const settingsContext = useContext(SensorSettingsContext);
  const logsContext = useContext(LogsContext);
  const activityLogsContext = useContext(ActivityLogsContext);
  
  if (!dataContext || !settingsContext || !logsContext || !activityLogsContext) {
    throw new Error("useSensors must be used within a SensorProvider");
  }
  
  return {
    // Sensor data fields
    data: dataContext.data,
    history: dataContext.history,
    loading: dataContext.loading,
    error: dataContext.error,
    connectionStatus: dataContext.connectionStatus,
    lastUpdate: dataContext.lastUpdate,
    consecutiveFailures: dataContext.consecutiveFailures,
    refetch: dataContext.refetch,
    // Settings fields
    settings: settingsContext.settings,
    settingsLoading: settingsContext.settingsLoading,
    settingsError: settingsContext.settingsError,
    saveError: settingsContext.saveError,
    refetchSettings: settingsContext.refetchSettings,
    saveSettings: settingsContext.saveSettings,
    settingsSaved: settingsContext.settingsSaved,
    settingsSaving: settingsContext.settingsSaving,
    // System logs fields
    logs: logsContext.logs,
    logsLoading: logsContext.logsLoading,
    logsError: logsContext.logsError,
    refetchLogs: logsContext.refetchLogs,
    logsPage: logsContext.logsPage,
    logsTotal: logsContext.logsTotal,
    logsCounts: logsContext.logsCounts,
    setLogsPage: logsContext.setLogsPage,
    // Activity logs fields
    activityLogs: activityLogsContext.activityLogs,
    activityLogsLoading: activityLogsContext.activityLogsLoading,
    activityLogsError: activityLogsContext.activityLogsError,
    activityLogsPage: activityLogsContext.activityLogsPage,
    activityLogsTotal: activityLogsContext.activityLogsTotal,
    activityLogsTotalPages: activityLogsContext.activityLogsTotalPages,
    activitySearch: activityLogsContext.activitySearch,
    activitySortBy: activityLogsContext.activitySortBy,
    activityActionFilter: activityLogsContext.activityActionFilter,
    setActivityLogsPage: activityLogsContext.setActivityLogsPage,
    setActivitySearch: activityLogsContext.setActivitySearch,
    setActivitySortBy: activityLogsContext.setActivitySortBy,
    setActivityActionFilter: activityLogsContext.setActivityActionFilter,
    refetchActivityLogs: activityLogsContext.refetchActivityLogs,
    logActivity: activityLogsContext.logActivity,
  };
}

/** Hook to access real-time sensor data. Alias for SensorContext's useSensorData. */
export function useSensorData() {
  const context = useContext(SensorDataContext);
  if (!context) {
    throw new Error("useSensorData must be used within a SensorProvider");
  }
  return context;
}

/** Hook to access sensor threshold settings. Alias for SensorContext's useSensorSettings. */
export function useSensorSettings() {
  const context = useContext(SensorSettingsContext);
  if (!context) {
    throw new Error("useSensorSettings must be used within a SensorProvider");
  }
  return context;
}

/** Hook to access system logs. Alias for SensorContext's useSystemLogs. */
export function useSystemLogs() {
  const context = useContext(LogsContext);
  if (!context) {
    throw new Error("useSystemLogs must be used within a SensorProvider");
  }
  return context;
}

/** Hook to access activity logs. Alias for SensorContext's useActivityLogs. */
export function useActivityLogs() {
  const context = useContext(ActivityLogsContext);
  if (!context) {
    throw new Error("useActivityLogs must be used within a SensorProvider");
  }
  return context;
}

/**
 * Hook that returns only connection-related fields.
 * Convenience for components that only need to display connection status.
 */
export function useConnectionStatus() {
  const { connectionStatus, lastUpdate, consecutiveFailures } = useSensorData();
  return { connectionStatus, lastUpdate, consecutiveFailures };
}

/**
 * Hook that returns only the logActivity function.
 * Convenience for components that only need to log user actions.
 */
export function useActivityLogger() {
  const context = useContext(ActivityLogsContext);
  if (!context) {
    throw new Error("useActivityLogger must be used within a SensorProvider");
  }
  return context.logActivity;
}
