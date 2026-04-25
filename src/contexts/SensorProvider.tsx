import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import {
  SensorDataContext,
  SensorSettingsContext,
  LogsContext,
  ActivityLogsContext,
} from "./SensorContext";
import type {
  SensorEntry,
  ChartPoint,
  LogEntry,
  SensorSettings,
  ActivityLog,
  ActivityActionType,
} from "../types";
import {
  fetchLatestSensor,
  fetchSensorHistory,
  fetchLogs,
  fetchSettings,
  fetchActivityLogs,
  logActivity as apiLogActivity,
  saveSettings as apiSaveSettings,
} from "../api/client";

const POLL_INTERVAL = 3000;
const OFFLINE_THRESHOLD = 15000;
const MAX_CONSECUTIVE_FAILURES = 5;
const LOGS_POLL_INTERVAL = 5000;
const LOGS_PAGE_SIZE = 20;

interface SensorDataState {
  data: SensorEntry | null;
  history: ChartPoint[];
  loading: boolean;
  error: string | null;
  connectionStatus: "online" | "offline" | "connecting" | "unknown";
  lastUpdate: Date | null;
  consecutiveFailures: number;
}

interface SensorSettingsState {
  settings: SensorSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  saveError: string | null;
  settingsSaved: boolean;
  settingsSaving: boolean;
}

interface LogsState {
  logs: LogEntry[];
  logsLoading: boolean;
  logsError: string | null;
  logsPage: number;
  logsTotal: number;
}

function computeConnectionStatus(
  loading: boolean,
  lastUpdate: Date | null
): "online" | "offline" | "connecting" | "unknown" {
  if (loading) return "connecting";
  if (!lastUpdate) return "unknown";
  const gap = Date.now() - lastUpdate.getTime();
  if (gap > OFFLINE_THRESHOLD) return "offline";
  return "online";
}

function useSensorDataPolling(): SensorDataState & { refetch: () => void } {
  const [state, setState] = useState<SensorDataState>({
    data: null,
    history: [],
    loading: true,
    error: null,
    connectionStatus: "connecting",
    lastUpdate: null,
    consecutiveFailures: 0,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const consecutiveFailuresRef = useRef(0);

  const fetchData = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const [latest, historyData] = await Promise.all([
        fetchLatestSensor(abortControllerRef.current.signal),
        fetchSensorHistory(50, abortControllerRef.current.signal),
      ]);

      if (latest) {
        consecutiveFailuresRef.current = 0;
        const now = new Date();
        setState({
          data: latest,
          history: historyData,
          loading: false,
          error: null,
          connectionStatus: computeConnectionStatus(false, now),
          lastUpdate: now,
          consecutiveFailures: 0,
        });
      } else {
        setState((prev) => ({
          ...prev,
          data: null,
          history: [],
          error: "No sensor data available",
          loading: false,
          connectionStatus: "unknown",
        }));
      }
    } catch {
      consecutiveFailuresRef.current += 1;

      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setState((prev) => ({
          ...prev,
          error: "Unable to connect to device. Device may be offline.",
          loading: false,
          connectionStatus: "offline",
          consecutiveFailures: consecutiveFailuresRef.current,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          consecutiveFailures: consecutiveFailuresRef.current,
          loading: false,
        }));
      }
    }
  }, []);

  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData]);

  const computedConnectionStatus = useMemo(
    () => computeConnectionStatus(state.loading, state.lastUpdate),
    [state.loading, state.lastUpdate]
  );

  return useMemo(
    () => ({
      ...state,
      connectionStatus: computedConnectionStatus,
      refetch: fetchData,
    }),
    [state, computedConnectionStatus, fetchData]
  );
}

function useSettingsManager(): SensorSettingsState & { refetch: () => void; save: (s: Partial<SensorSettings>) => Promise<void> } {
  const [state, setState] = useState<SensorSettingsState>({
    settings: null,
    settingsLoading: true,
    settingsError: null,
    saveError: null,
    settingsSaved: false,
    settingsSaving: false,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const settings = await fetchSettings(abortControllerRef.current.signal);
      setState((prev) => ({
        ...prev,
        settings,
        settingsLoading: false,
        settingsError: null,
      }));
    } catch {
      setState((prev) => ({
        ...prev,
        settingsLoading: false,
        settingsError: "Failed to load settings",
      }));
    }
  }, []);

  useEffect(() => {
    fetchData();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current);
      }
    };
  }, [fetchData]);

  const save = useCallback(async (newSettings: Partial<SensorSettings>) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState((prev) => ({ ...prev, settingsSaving: true, saveError: null }));

    try {
      await apiSaveSettings(newSettings, abortControllerRef.current.signal);
      setState((prev) => ({
        ...prev,
        settingsSaving: false,
        settingsSaved: true,
        settings: prev.settings ? { ...prev.settings, ...newSettings } : null,
      }));

      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current);
      }
      savedTimeoutRef.current = setTimeout(() => {
        setState((prev) => ({ ...prev, settingsSaved: false }));
      }, 2000);
    } catch {
      setState((prev) => ({
        ...prev,
        settingsSaving: false,
        saveError: "Failed to save settings",
      }));
    }
  }, []);

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, settingsLoading: true, settingsError: null, saveError: null }));
    fetchData();
  }, [fetchData]);

  return useMemo(
    () => ({
      ...state,
      refetch,
      save,
    }),
    [state, refetch, save]
  );
}

function useLogsManager(): LogsState & { refetch: () => void; setPage: (page: number) => void } {
  const [state, setState] = useState<LogsState>({
    logs: [],
    logsLoading: true,
    logsError: null,
    logsPage: 1,
    logsTotal: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (page = 1) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetchLogs(page, LOGS_PAGE_SIZE, abortControllerRef.current.signal);
      setState((prev) => ({
        ...prev,
        logs: response.data,
        logsLoading: false,
        logsError: null,
        logsPage: response.page,
        logsTotal: response.total,
      }));
    } catch {
      setState((prev) => ({
        ...prev,
        logsLoading: false,
        logsError: "Failed to load logs",
      }));
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(state.logsPage), LOGS_POLL_INTERVAL);

    return () => {
      clearInterval(interval);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData, state.logsPage]);

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, logsLoading: true, logsError: null }));
    fetchData();
  }, [fetchData]);

  const setPage = useCallback((page: number) => {
    setState((prev) => ({ ...prev, logsPage: page }));
    fetchData(page);
  }, [fetchData]);

  return useMemo(
    () => ({
      ...state,
      refetch,
      setPage,
    }),
    [state, refetch, setPage]
  );
}

interface ActivityLogsState {
  activityLogs: ActivityLog[];
  activityLogsLoading: boolean;
  activityLogsError: string | null;
  activityLogsPage: number;
  activityLogsTotal: number;
  activityLogsTotalPages: number;
  activitySearch: string;
  activitySortBy: "newest" | "oldest";
  activityActionFilter: string;
}

function useActivityLogsManager() {
  const [state, setState] = useState<ActivityLogsState>({
    activityLogs: [],
    activityLogsLoading: true,
    activityLogsError: null,
    activityLogsPage: 1,
    activityLogsTotal: 0,
    activityLogsTotalPages: 0,
    activitySearch: "",
    activitySortBy: "newest",
    activityActionFilter: "",
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  const fetchData = useCallback(async (page = 1, search?: string, sortBy?: "newest" | "oldest", actionFilter?: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    const currentSearch = search ?? state.activitySearch;
    const currentSort = sortBy ?? state.activitySortBy;
    const currentFilter = actionFilter ?? state.activityActionFilter;

    try {
      const response = await fetchActivityLogs(
        page,
        20,
        currentSearch,
        currentSort,
        currentFilter || undefined,
        abortControllerRef.current.signal
      );
      
      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          activityLogs: response.data,
          activityLogsLoading: false,
          activityLogsError: null,
          activityLogsPage: response.page,
          activityLogsTotal: response.total,
          activityLogsTotalPages: response.totalPages,
        }));
      }
    } catch {
      if (isMountedRef.current) {
        setState((prev) => ({
          ...prev,
          activityLogsLoading: false,
          activityLogsError: "Failed to load activity logs",
        }));
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    fetchData();

    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, activityLogsLoading: true, activityLogsError: null }));
    fetchData();
  }, [fetchData]);

  const setPage = useCallback((page: number) => {
    setState((prev) => ({ ...prev, activityLogsPage: page }));
    fetchData(page);
  }, [fetchData]);

  const setSearch = useCallback((search: string) => {
    setState((prev) => ({ ...prev, activitySearch: search, activityLogsPage: 1 }));
    fetchData(1, search);
  }, [fetchData]);

  const setSortBy = useCallback((sort: "newest" | "oldest") => {
    setState((prev) => ({ ...prev, activitySortBy: sort, activityLogsPage: 1 }));
    fetchData(1, undefined, sort);
  }, [fetchData]);

  const setActionFilter = useCallback((filter: string) => {
    setState((prev) => ({ ...prev, activityActionFilter: filter, activityLogsPage: 1 }));
    fetchData(1, undefined, undefined, filter);
  }, [fetchData]);

  const logActivity = useCallback((actionType: ActivityActionType, description: string, module: string) => {
    apiLogActivity({ action_type: actionType, description, module });
  }, []);

  return useMemo(
    () => ({
      ...state,
      refetch,
      setPage,
      setSearch,
      setSortBy,
      setActionFilter,
      logActivity,
    }),
    [state, refetch, setPage, setSearch, setSortBy, setActionFilter, logActivity]
  );
}

export function SensorProvider({ children }: { children: ReactNode }) {
  const sensorData = useSensorDataPolling();
  const settingsState = useSettingsManager();
  const logsState = useLogsManager();
  const activityLogsState = useActivityLogsManager();

  const dataContextValue = useMemo(
    () => ({
      data: sensorData.data,
      history: sensorData.history,
      loading: sensorData.loading,
      error: sensorData.error,
      connectionStatus: sensorData.connectionStatus,
      lastUpdate: sensorData.lastUpdate,
      consecutiveFailures: sensorData.consecutiveFailures,
      refetch: sensorData.refetch,
    }),
    [sensorData]
  );

  const settingsContextValue = useMemo(
    () => ({
      settings: settingsState.settings,
      settingsLoading: settingsState.settingsLoading,
      settingsError: settingsState.settingsError,
      saveError: settingsState.saveError,
      refetchSettings: settingsState.refetch,
      saveSettings: settingsState.save,
      settingsSaved: settingsState.settingsSaved,
      settingsSaving: settingsState.settingsSaving,
    }),
    [settingsState]
  );

  const logsContextValue = useMemo(
    () => ({
      logs: logsState.logs,
      logsLoading: logsState.logsLoading,
      logsError: logsState.logsError,
      refetchLogs: logsState.refetch,
      logsPage: logsState.logsPage,
      logsTotal: logsState.logsTotal,
      setLogsPage: logsState.setPage,
    }),
    [logsState]
  );

  const activityLogsContextValue = useMemo(
    () => ({
      activityLogs: activityLogsState.activityLogs,
      activityLogsLoading: activityLogsState.activityLogsLoading,
      activityLogsError: activityLogsState.activityLogsError,
      activityLogsPage: activityLogsState.activityLogsPage,
      activityLogsTotal: activityLogsState.activityLogsTotal,
      activityLogsTotalPages: activityLogsState.activityLogsTotalPages,
      activitySearch: activityLogsState.activitySearch,
      activitySortBy: activityLogsState.activitySortBy,
      activityActionFilter: activityLogsState.activityActionFilter,
      setActivityLogsPage: activityLogsState.setPage,
      setActivitySearch: activityLogsState.setSearch,
      setActivitySortBy: activityLogsState.setSortBy,
      setActivityActionFilter: activityLogsState.setActionFilter,
      refetchActivityLogs: activityLogsState.refetch,
      logActivity: activityLogsState.logActivity,
    }),
    [activityLogsState]
  );

  return (
    <SensorDataContext.Provider value={dataContextValue}>
      <SensorSettingsContext.Provider value={settingsContextValue}>
        <LogsContext.Provider value={logsContextValue}>
          <ActivityLogsContext.Provider value={activityLogsContextValue}>
            {children}
          </ActivityLogsContext.Provider>
        </LogsContext.Provider>
      </SensorSettingsContext.Provider>
    </SensorDataContext.Provider>
  );
}

export { useSensorData, useSensorSettings, useSystemLogs, useActivityLogs } from "./SensorContext";

export default SensorProvider;