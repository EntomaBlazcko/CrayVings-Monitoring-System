// =============================================================================
// FILE: src/contexts/SensorProvider.tsx
// =============================================================================
// PURPOSE: Central data management provider for the CRAYvings Monitoring System.
//
// This is the most important state management file in the frontend. It:
//   1. Polls the backend API every 3 seconds for live sensor data
//   2. Manages connection status (online/offline/connecting/unknown)
//   3. Fetches and caches sensor threshold settings
//   4. Fetches and paginates system logs
//   5. Fetches and manages activity logs with search/filter/sort
//   6. Provides all state via React Context to child components
//
// DATA POLLING ARCHITECTURE:
//   - Sensor data: Polled every 3 seconds (POLL_INTERVAL)
//   - System logs: Polled every 5 seconds (LOGS_POLL_INTERVAL)
//   - Settings: Fetched once on mount, re-fetched on demand
//   - Activity logs: Fetched once on mount, re-fetched on demand
//
// ABORT CONTROLLER PATTERN:
//   Each fetch operation uses an AbortController to cancel in-flight
//   requests when a new poll starts or the component unmounts.
//   This prevents race conditions and memory leaks.
//
// CONNECTION STATUS LOGIC:
//   - "connecting": Loading state or initial fetch in progress
//   - "online":      Data received within last 15 seconds
//   - "offline":     No data for 15+ seconds or 5+ consecutive failures
//   - "unknown":     No data has ever been received
//
// FOUR CUSTOM HOOKS INSIDE THIS FILE:
//   1. useSensorDataPolling()   - Live sensor data + history + connection
//   2. useSettingsManager()     - Threshold settings + save operations
//   3. useLogsManager()         - System logs pagination
//   4. useActivityLogsManager() - Activity logs with search/filter/sort
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
// How often to poll the backend for fresh data.
const POLL_INTERVAL = 3000;              // 3 seconds for sensor data
const OFFLINE_THRESHOLD = 15000;         // 15 seconds without data = offline
const MAX_CONSECUTIVE_FAILURES = 5;      // After 5 failures, mark as offline
const LOGS_POLL_INTERVAL = 5000;         // 5 seconds for system logs
const LOGS_PAGE_SIZE = 20;               // 20 logs per page

// ========================
// STATE INTERFACES
// ========================
// Internal state shapes for each data domain.

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
  logsCounts: Record<string, number>;
  logsActionFilter: string;
  logsParameterFilter: string;
}

// ========================
// CONNECTION STATUS HELPER
// ========================
/**
 * Computes the connection status based on loading state, last update time,
 * and consecutive polling failures.
 * This is a pure function used for consistent status calculation.
 */
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
/**
 * Custom hook that polls the backend for live sensor data every 3 seconds.
 * Fetches both the latest reading and historical data in parallel.
 * Manages connection status, error states, and consecutive failure counting.
 *
 * Features:
 *   - AbortController for canceling stale requests
 *   - Stale data detection (timestamp gap > 15 seconds)
 *   - Consecutive failure tracking for offline detection
 *   - Automatic cleanup on unmount
 */
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

  /**
   * Fetches latest sensor data and history from the backend.
   * Uses Promise.all to fetch both in parallel for efficiency.
   * Handles success, no-data, and error cases.
   */
  const fetchData = useCallback(async () => {
    // Cancel any in-flight request before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      // Fetch latest reading and chart history simultaneously
      const [latest, historyData] = await Promise.all([
        fetchLatestSensor(abortControllerRef.current.signal),
        fetchSensorHistory(1000, abortControllerRef.current.signal),
      ]);

      if (latest && latest.timestamp) {
        consecutiveFailuresRef.current = 0
        const sensorTime = new Date(latest.timestamp);
        const gap = Date.now() - sensorTime.getTime();
        const isStale = gap > OFFLINE_THRESHOLD;

        setState({
          data: latest,
          history: historyData,
          loading: false,
          error: isStale ? "ESP32 device is offline. Last data received is stale." : null,
          connectionStatus: computeConnectionStatus(false, sensorTime),
          lastUpdate: sensorTime,
          consecutiveFailures: 0,
        });
      } else {
        // No latest reading, but preserve any historical data we already have
        setState((prev) => ({
          ...prev,
          data: null,
          history: historyData.length > 0 ? historyData : prev.history,
          error: historyData.length > 0 ? "ESP32 device is offline. No new data received." : "No sensor data available",
          loading: false,
          connectionStatus: "unknown",
        }));
      }
    } catch (error) {
      // A canceled request just means the next poll superseded it (or the
      // component unmounted) — that's not a failure, so don't count it.
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;

      consecutiveFailuresRef.current += 1;

      // Only show error after multiple consecutive failures
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

  // Start polling on mount, clean up on unmount
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

  // Recompute connection status whenever loading, lastUpdate, or failures change
  const computedConnectionStatus = useMemo(
    () => computeConnectionStatus(state.loading, state.lastUpdate, state.consecutiveFailures),
    [state.loading, state.lastUpdate, state.consecutiveFailures]
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

// ========================
// HOOK 2: SETTINGS MANAGER
// ========================
/**
 * Custom hook that manages sensor threshold settings.
 * Fetches settings on mount, provides save functionality,
 * and handles loading/error states.
 */
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

  /** Fetches current settings from the backend. */
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

  /**
   * Saves updated settings to the backend.
   * Optimistically updates local state, shows "saved" confirmation for 2 seconds.
   */
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

      // Clear "saved" confirmation after 2 seconds
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

  /** Re-fetches settings from the backend (e.g., after a reset). */
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
/**
 * Custom hook that manages paginated system logs.
 * Auto-polls every 5 seconds for fresh log entries.
 */
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

  /** Fetches a specific page of system logs with the active filters. */
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

  // Fetch logs on mount and set up auto-polling
  useEffect(() => {
    fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter);
    const interval = setInterval(
      () => fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter),
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
/**
 * Custom hook that manages user activity logs with advanced features:
 *   - Pagination (20 entries per page)
 *   - Search (by description or user name, case-insensitive)
 *   - Sort (newest/oldest first)
 *   - Filter (by action type)
 *
 * Uses isMountedRef to prevent state updates on unmounted components,
 * and stateRef to access the latest state in async callbacks.
 */
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

  // Keep stateRef in sync with current state for use in async callbacks
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /**
   * Fetches activity logs with the specified page, search, sort, and filter.
   * Uses stateRef to get the latest values if parameters aren't explicitly provided.
   */
  const fetchData = useCallback(async (page = 1, search?: string, sortBy?: "newest" | "oldest", actionFilter?: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    const currentState = stateRef.current;
    // Use parameters if provided, otherwise use current state
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
  }, []);

  const setSearch = useCallback((search: string) => {
    setState((prev) => ({ ...prev, activitySearch: search, activityLogsPage: 1 }));
    fetchData(1, search);
  }, []);

  const setSortBy = useCallback((sort: "newest" | "oldest") => {
    setState((prev) => ({ ...prev, activitySortBy: sort, activityLogsPage: 1 }));
    fetchData(1, undefined, sort);
  }, []);

  const setActionFilter = useCallback((filter: string) => {
    setState((prev) => ({ ...prev, activityActionFilter: filter, activityLogsPage: 1 }));
    fetchData(1, undefined, undefined, filter);
  }, []);

  /**
   * Logs a user activity event to the backend.
   * Fire-and-forget: errors are handled silently by the API client.
   */
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
/**
 * Main context provider that combines all four data hooks.
 * Wraps child components in all four context providers, making
 * sensor data, settings, logs, and activity logs available globally.
 *
 * Usage in App.tsx:
 *   <SensorProvider>
 *     <AppContent />
 *   </SensorProvider>
 */
export function SensorProvider({ children }: { children: ReactNode }) {
  const sensorData = useSensorDataPolling();
  const settingsState = useSettingsManager();
  const logsState = useLogsManager();
  const activityLogsState = useActivityLogsManager();

  // Memoize context values to prevent unnecessary re-renders of consumers
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
