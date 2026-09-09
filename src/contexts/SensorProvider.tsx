// =============================================================================
// src/contexts/SensorProvider.tsx
// Central data provider: polls sensors (1s), logs (5s), settings, activity logs.
// Four hooks: useSensorDataPolling, useSettingsManager, useLogsManager, useActivityLogsManager.
// =============================================================================

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import { isAxiosError } from "axios";
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

// ========================
// POLLING CONFIGURATION
// ========================
const POLL_INTERVAL = 1000;             // 1s sensor data (matches ESP32 send rate)
const HISTORY_POLL_INTERVAL = 30000;     // 30s chart history (heavy query)
const OFFLINE_THRESHOLD = 15000;         // 15s without data = offline
const MAX_CONSECUTIVE_FAILURES = 5;      // After 5 failures, mark offline
const LOGS_POLL_INTERVAL = 5000;         // 5s system logs
const LOGS_PAGE_SIZE = 20;

// ========================
// STATE INTERFACES
// ========================

interface SensorDataState {
  data: SensorEntry | null;
  history: ChartPoint[];
  loading: boolean;
  error: string | null;
  connectionStatus: "online" | "offline" | "connecting" | "unknown";
  lastUpdate: Date | null;
  consecutiveFailures: number;
  historyStale: boolean;
  historyLastUpdated: Date | null;
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
  logsCounts: Record<string, number>;
  logsActionFilter: string;
  logsParameterFilter: string;
}

// ========================
// CONNECTION STATUS HELPER
// ========================
// Pure function: derives online/offline/connecting/unknown from last update + failure count.
function computeConnectionStatus(
  loading: boolean,
  lastUpdate: Date | null,
  consecutiveFailures = 0
): "online" | "offline" | "connecting" | "unknown" {
  if (loading) return "connecting";
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return "offline";
  if (!lastUpdate) return "unknown";
  const gap = Date.now() - lastUpdate.getTime();
  if (gap > OFFLINE_THRESHOLD) return "offline";
  return "online";
}

// ========================
// HOOK 1: SENSOR DATA POLLING
// ========================
// Polls sensor data every 1s + history every 30s. Tracks connection status via
// consecutive failures and stale timestamps. Uses request IDs (not AbortController)
// to drop superseded responses without canceling in-flight requests.
function useSensorDataPolling(): SensorDataState & { refetch: () => void } {
  const [state, setState] = useState<SensorDataState>({
    data: null,
    history: [],
    loading: true,
    error: null,
    connectionStatus: "connecting",
    lastUpdate: null,
    consecutiveFailures: 0,
    historyStale: false,
    historyLastUpdated: null,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const historyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestAbortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  // Request IDs: drop superseded responses without aborting (aborting caused
  // ERR_CANCELED to bypass the failure counter, freezing status at "online").
  const latestReqIdRef = useRef(0);
  const historyReqIdRef = useRef(0);
  const consecutiveFailuresRef = useRef(0);

  // Fetches latest sensor reading (every 1s). Connection status derived from timestamp.
  const fetchLatest = useCallback(async () => {
    // Bump id so any in-flight response from a prior poll is ignored.
    const reqId = ++latestReqIdRef.current;
    latestAbortRef.current = new AbortController();

    try {
      const latest = await fetchLatestSensor(latestAbortRef.current.signal);
      if (reqId !== latestReqIdRef.current) return; // superseded by a newer poll

      if (latest && latest.timestamp) {
        consecutiveFailuresRef.current = 0;
        const sensorTime = new Date(latest.timestamp);
        const gap = Date.now() - sensorTime.getTime();
        const isStale = gap > OFFLINE_THRESHOLD;

        setState((prev) => ({
          ...prev,
          data: latest,
          loading: false,
          error: isStale ? "ESP32 device is offline. Last data received is stale." : null,
          connectionStatus: computeConnectionStatus(false, sensorTime),
          lastUpdate: sensorTime,
          consecutiveFailures: 0,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          data: null,
          loading: false,
          error: prev.history.length > 0 ? "ESP32 device is offline. No new data received." : "No sensor data available",
          connectionStatus: "unknown",
        }));
      }
    } catch (error) {
      // Superseded or unmounted: not a real failure.
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;
      if (reqId !== latestReqIdRef.current) return;

      consecutiveFailuresRef.current += 1;

      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setState((prev) => ({
          ...prev,
          error: "Unable to reach the server. Check your connection and try again.",
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

  // Fetches chart history (every 30s). Errors swallowed; last good data stays on screen.
  const fetchHistory = useCallback(async () => {
    const reqId = ++historyReqIdRef.current;
    historyAbortRef.current = new AbortController();

    try {
      const historyData = await fetchSensorHistory(1000, historyAbortRef.current.signal);
      if (reqId !== historyReqIdRef.current) return;
      setState((prev) => ({ ...prev, history: historyData, historyStale: false, historyLastUpdated: new Date() }));
    } catch (error) {
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;
      // Mark stale so UI can show "chart data may be outdated" warning.
      if (reqId === historyReqIdRef.current) {
        setState((prev) => ({ ...prev, historyStale: true }));
      }
    }
  }, []);

  const refetch = useCallback(() => {
    fetchLatest();
    fetchHistory();
  }, [fetchLatest, fetchHistory]);

  // Start polling on mount; both pause while the tab is hidden.
  useEffect(() => {
    refetch();
    intervalRef.current = setInterval(() => {
      if (!document.hidden) fetchLatest();
    }, POLL_INTERVAL);
    historyIntervalRef.current = setInterval(() => {
      if (!document.hidden) fetchHistory();
    }, HISTORY_POLL_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (historyIntervalRef.current) {
        clearInterval(historyIntervalRef.current);
      }
      if (latestAbortRef.current) {
        latestAbortRef.current.abort();
      }
      if (historyAbortRef.current) {
        historyAbortRef.current.abort();
      }
    };
  }, [refetch, fetchLatest, fetchHistory]);

  const computedConnectionStatus = useMemo(
    () => computeConnectionStatus(state.loading, state.lastUpdate, state.consecutiveFailures),
    [state.loading, state.lastUpdate, state.consecutiveFailures]
  );

  return useMemo(
    () => ({
      ...state,
      connectionStatus: computedConnectionStatus,
      refetch,
    }),
    [state, computedConnectionStatus, refetch]
  );
}

// ========================
// HOOK 2: SETTINGS MANAGER
// ========================
// Manages sensor threshold settings: fetch on mount, save with optimistic update.
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

  // Saves settings: optimistic local update + "saved" confirmation for 2s.
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

// ========================
// HOOK 3: LOGS MANAGER
// ========================
// Paginated system logs, auto-polled every 5s.
function useLogsManager(): LogsState & { refetch: () => void; setPage: (page: number) => void; setLogsActionFilter: (filter: string) => void; setLogsParameterFilter: (filter: string) => void } {
  const [state, setState] = useState<LogsState>({
    logs: [],
    logsLoading: true,
    logsError: null,
    logsPage: 1,
    logsTotal: 0,
    logsCounts: {},
    logsActionFilter: "",
    logsParameterFilter: "",
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (page = 1, actionFilter = "", parameterFilter = "") => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetchLogs(
        page,
        LOGS_PAGE_SIZE,
        abortControllerRef.current.signal,
        {
          action: actionFilter || undefined,
          parameter: parameterFilter || undefined,
        }
      );
      setState((prev) => ({
        ...prev,
        logs: response.data,
        logsLoading: false,
        logsError: null,
        logsPage: response.page,
        logsTotal: response.total,
        logsCounts: response.counts || {},
      }));
    } catch (error) {
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;
      setState((prev) => ({
        ...prev,
        logsLoading: false,
        logsError: "Failed to load logs",
      }));
    }
  }, []);

  // Fetch on mount; auto-poll pauses while the tab is hidden.
  useEffect(() => {
    fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter);
    const interval = setInterval(
      () => {
        if (!document.hidden) fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter);
      },
      LOGS_POLL_INTERVAL
    );

    return () => {
      clearInterval(interval);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData, state.logsPage, state.logsActionFilter, state.logsParameterFilter]);

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, logsLoading: true, logsError: null }));
    fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter);
  }, [fetchData, state.logsPage, state.logsActionFilter, state.logsParameterFilter]);

  const setPage = useCallback((page: number) => {
    setState((prev) => ({ ...prev, logsPage: page }));
  }, []);

  const setLogsActionFilter = useCallback((filter: string) => {
    setState((prev) => ({
      ...prev,
      logsActionFilter: filter,
      logsPage: 1,
    }));
    fetchData(1, filter, state.logsParameterFilter);
  }, [fetchData, state.logsParameterFilter]);

  const setLogsParameterFilter = useCallback((filter: string) => {
    setState((prev) => ({
      ...prev,
      logsParameterFilter: filter,
      logsPage: 1,
    }));
    fetchData(1, state.logsActionFilter, filter);
  }, [fetchData, state.logsActionFilter]);

  return useMemo(
    () => ({
      ...state,
      refetch,
      setPage,
      setLogsActionFilter,
      setLogsParameterFilter,
    }),
    [state, refetch, setPage, setLogsActionFilter, setLogsParameterFilter]
  );
}

// ========================
// HOOK 4: ACTIVITY LOGS MANAGER
// ========================
// Activity logs with pagination (20/page), search, sort, and action-type filter.
// Uses isMountedRef to prevent setState on unmounted components.
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
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Fetches activity logs with optional page/search/sort/filter params.
  const fetchData = useCallback(async (page = 1, search?: string, sortBy?: "newest" | "oldest", actionFilter?: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    const currentState = stateRef.current;
    const currentSearch = search !== undefined ? search : currentState.activitySearch;
    const currentSort = sortBy !== undefined ? sortBy : currentState.activitySortBy;
    const currentFilter = actionFilter !== undefined ? actionFilter : currentState.activityActionFilter;

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
          activityLogsTotalPages: response.totalPages ?? Math.ceil((response.total || 0) / 20),
        }));
      }
    } catch (error) {
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;
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
  }, [fetchData]);

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

  // Fire-and-forget: logs user activity to the backend.
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

// ========================
// SENSOR PROVIDER COMPONENT
// ========================
// Combines all four hooks into a single provider tree.
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
      historyStale: sensorData.historyStale,
      historyLastUpdated: sensorData.historyLastUpdated,
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
      logsCounts: logsState.logsCounts,
      setLogsPage: logsState.setPage,
      logsActionFilter: logsState.logsActionFilter,
      setLogsActionFilter: logsState.setLogsActionFilter,
      logsParameterFilter: logsState.logsParameterFilter,
      setLogsParameterFilter: logsState.setLogsParameterFilter,
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

export default SensorProvider;
