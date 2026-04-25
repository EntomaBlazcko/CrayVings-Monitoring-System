import { useContext } from "react";
import { SensorDataContext, SensorSettingsContext, LogsContext, ActivityLogsContext } from "../contexts/SensorContext";

export function useSensors() {
  const dataContext = useContext(SensorDataContext);
  const settingsContext = useContext(SensorSettingsContext);
  const logsContext = useContext(LogsContext);
  const activityLogsContext = useContext(ActivityLogsContext);
  
  if (!dataContext || !settingsContext || !logsContext || !activityLogsContext) {
    throw new Error("useSensors must be used within a SensorProvider");
  }
  
  return {
    data: dataContext.data,
    history: dataContext.history,
    loading: dataContext.loading,
    error: dataContext.error,
    connectionStatus: dataContext.connectionStatus,
    lastUpdate: dataContext.lastUpdate,
    consecutiveFailures: dataContext.consecutiveFailures,
    refetch: dataContext.refetch,
    settings: settingsContext.settings,
    settingsLoading: settingsContext.settingsLoading,
    settingsError: settingsContext.settingsError,
    saveError: settingsContext.saveError,
    refetchSettings: settingsContext.refetchSettings,
    saveSettings: settingsContext.saveSettings,
    settingsSaved: settingsContext.settingsSaved,
    settingsSaving: settingsContext.settingsSaving,
    logs: logsContext.logs,
    logsLoading: logsContext.logsLoading,
    logsError: logsContext.logsError,
    refetchLogs: logsContext.refetchLogs,
    logsPage: logsContext.logsPage,
    logsTotal: logsContext.logsTotal,
    setLogsPage: logsContext.setLogsPage,
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

export function useSensorData() {
  const context = useContext(SensorDataContext);
  if (!context) {
    throw new Error("useSensorData must be used within a SensorProvider");
  }
  return context;
}

export function useSensorSettings() {
  const context = useContext(SensorSettingsContext);
  if (!context) {
    throw new Error("useSensorSettings must be used within a SensorProvider");
  }
  return context;
}

export function useSystemLogs() {
  const context = useContext(LogsContext);
  if (!context) {
    throw new Error("useSystemLogs must be used within a SensorProvider");
  }
  return context;
}

export function useActivityLogs() {
  const context = useContext(ActivityLogsContext);
  if (!context) {
    throw new Error("useActivityLogs must be used within a SensorProvider");
  }
  return context;
}

export function useConnectionStatus() {
  const { connectionStatus, lastUpdate, consecutiveFailures } = useSensorData();
  return { connectionStatus, lastUpdate, consecutiveFailures };
}

export function useActivityLogger() {
  const context = useContext(ActivityLogsContext);
  if (!context) {
    throw new Error("useActivityLogger must be used within a SensorProvider");
  }
  return context.logActivity;
}