// Central data provider. Live readings arrive over SSE (/sensor/stream); chart
// history polls every 30s and the fleet registry every 5s. Polls pause while
// the tab is hidden.

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
  DeviceEntry,
} from "../types";
import {
  fetchLatestSensor,
  fetchSensorHistory,
  fetchLogs,
  fetchSettings,
  fetchActivityLogs,
  fetchDevices,
  logActivity as apiLogActivity,
  saveSettings as apiSaveSettings,
} from "../api/client";

const HISTORY_POLL_INTERVAL = 30000;
const DEVICES_POLL_INTERVAL = 5000;
const LOGS_POLL_INTERVAL = 5000;
const LOGS_PAGE_SIZE = 10;

const HEARTBEAT_STALE_MS = 30000; // no heartbeat for 30s -> offline
const MAX_CONSECUTIVE_FAILURES = 5;
const SSE_MAX_RECONNECT_ATTEMPTS = 10;

// 401s are re-thrown so the axios response interceptor can clear the session
// and route back to the login screen.
function isSessionExpired(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 401;
}

function computeConnectionStatus(
  loading: boolean,
  lastUpdate: Date | null,
  consecutiveFailures = 0
): "online" | "offline" | "connecting" | "unknown" {
  if (loading) return "connecting";
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return "offline";
  if (!lastUpdate) return "unknown";
  if (Date.now() - lastUpdate.getTime() > HEARTBEAT_STALE_MS) return "offline";
  return "online";
}

interface SensorDataState {
  latestReading: SensorEntry | null;
  history: ChartPoint[];
  loading: boolean;
  error: string | null;
  connectionStatus: "online" | "offline" | "connecting" | "unknown";
  lastUpdate: Date | null;
  consecutiveFailures: number;
  historyStale: boolean;
  historyLastUpdated: Date | null;
  devices: DeviceEntry[];
  devicesLoading: boolean;
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

function useSensorDataPolling(
  selectedDeviceId: string | null,
  onDevicesLoaded: (devices: DeviceEntry[]) => void
): SensorDataState & { refetch: () => void } {
  const [state, setState] = useState<SensorDataState>({
    latestReading: null,
    history: [],
    loading: true,
    error: null,
    connectionStatus: "connecting",
    lastUpdate: null,
    consecutiveFailures: 0,
    historyStale: false,
    historyLastUpdated: null,
    devices: [],
    devicesLoading: true,
  });

  const historyAbortRef = useRef<AbortController | null>(null);
  const devicesAbortRef = useRef<AbortController | null>(null);
  const historyReqIdRef = useRef(0);
  const devicesReqIdRef = useRef(0);
  const consecutiveFailuresRef = useRef(0);

  // Request IDs drop superseded responses without aborting in-flight requests
  // (aborting let ERR_CANCELED bypass the failure counter and freeze status at
  // "online").
  const fetchHistory = useCallback(async () => {
    const reqId = ++historyReqIdRef.current;
    historyAbortRef.current = new AbortController();

    try {
      const historyData = await fetchSensorHistory(1000, selectedDeviceId, historyAbortRef.current.signal);
      if (reqId !== historyReqIdRef.current) return;
      setState((prev) => ({ ...prev, history: historyData, historyStale: false, historyLastUpdated: new Date() }));
    } catch (error) {
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;
      if (reqId === historyReqIdRef.current) {
        // Flag as stale so charts can show the "may be outdated" warning;
        // otherwise keep the last good data on screen.
        setState((prev) => ({ ...prev, historyStale: true }));
      }
    }
  }, [selectedDeviceId]);

  const fetchDevicesList = useCallback(async () => {
    const reqId = ++devicesReqIdRef.current;
    devicesAbortRef.current = new AbortController();

    try {
      const devices = await fetchDevices(false, devicesAbortRef.current.signal);
      if (reqId !== devicesReqIdRef.current) return;
      setState((prev) => ({ ...prev, devices, devicesLoading: false }));
      onDevicesLoaded(devices);
    } catch (error) {
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;
      if (reqId === devicesReqIdRef.current) {
        // Keep the last known fleet; the next poll retries quietly.
        setState((prev) => ({ ...prev, devicesLoading: false }));
      }
    }
  }, [onDevicesLoaded]);

  const applyLatestReading = useCallback((reading: SensorEntry) => {
    const sensorTime = new Date(reading.recv_at || reading.timestamp || "");
    setState((prev) => ({
      ...prev,
      latestReading: reading,
      loading: false,
      error: null,
      connectionStatus: computeConnectionStatus(false, sensorTime),
      lastUpdate: sensorTime,
      consecutiveFailures: 0,
    }));
  }, []);

  const refetch = useCallback(() => {
    fetchHistory();
    fetchDevicesList();
    fetchLatestSensor(selectedDeviceId)
      .then((result) => {
        if (result.data && result.data.timestamp) applyLatestReading(result.data);
      })
      .catch(() => {
        // SSE handles real-time updates; refetch is best-effort.
      });
  }, [fetchHistory, fetchDevicesList, selectedDeviceId, applyLatestReading]);

  // SSE stream for live readings, with exponential-backoff reconnects.
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    const connectSSE = () => {
      if (eventSource) {
        eventSource.close();
      }

      setState((prev) => ({ ...prev, loading: true, connectionStatus: "connecting" }));

      const baseUrl = import.meta.env.VITE_API_BASE || "http://localhost:3000";
      // EventSource cannot set Authorization headers, so the session token
      // travels as a query parameter (the server accepts it for SSE).
      const params = new URLSearchParams();
      const token = localStorage.getItem("crayvings_token");
      if (token) params.set("token", token);
      if (selectedDeviceId) params.set("device_id", selectedDeviceId);
      const url = `${baseUrl}/sensor/stream${params.toString() ? `?${params.toString()}` : ""}`;

      try {
        const es = new EventSource(url, { withCredentials: true });
        eventSource = es;

        es.onopen = () => {
          reconnectAttempts = 0;
          setState((prev) => ({
            ...prev,
            loading: false,
            connectionStatus: "online",
            error: null,
          }));
        };

        es.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "sensor_update" && message.data) {
              applyLatestReading(message.data);
              consecutiveFailuresRef.current = 0;
            }
          } catch {
            // Malformed frame — ignore it.
          }
        };

        es.onerror = () => {
          setState((prev) => ({
            ...prev,
            connectionStatus: "offline",
            error: "Real-time connection lost. Attempting to reconnect...",
          }));
          es.close();

          if (reconnectAttempts < SSE_MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000) + Math.random() * 1000;
            reconnectAttempts++;
            setState((prev) => ({
              ...prev,
              error: `Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${reconnectAttempts}/${SSE_MAX_RECONNECT_ATTEMPTS})`,
            }));

            reconnectTimeout = setTimeout(() => {
              connectSSE();
            }, delay);
          } else {
            setState((prev) => ({
              ...prev,
              error: "Max reconnection attempts reached. Please refresh the page.",
              connectionStatus: "offline",
            }));
          }
        };
      } catch {
        setState((prev) => ({
          ...prev,
          loading: false,
          connectionStatus: "offline",
          error: "Failed to establish real-time connection",
        }));
      }
    };

    connectSSE();

    // Seed the latest reading via REST so a freshly opened dashboard has data
    // before the next device POST arrives.
    fetchLatestSensor(selectedDeviceId)
      .then((result) => {
        if (result.data && result.data.timestamp) applyLatestReading(result.data);
      })
      .catch(() => {
        // SSE will deliver readings once the device posts.
      });

    return () => {
      if (eventSource) {
        eventSource.close();
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, [selectedDeviceId, applyLatestReading]);

  useEffect(() => {
    fetchHistory();
    const historyInterval = setInterval(() => {
      if (!document.hidden) fetchHistory();
    }, HISTORY_POLL_INTERVAL);

    return () => {
      clearInterval(historyInterval);
      if (historyAbortRef.current) {
        historyAbortRef.current.abort();
      }
    };
  }, [fetchHistory]);

  useEffect(() => {
    fetchDevicesList();
    const devicesInterval = setInterval(() => {
      if (!document.hidden) fetchDevicesList();
    }, DEVICES_POLL_INTERVAL);

    return () => {
      clearInterval(devicesInterval);
      if (devicesAbortRef.current) {
        devicesAbortRef.current.abort();
      }
    };
  }, [fetchDevicesList]);

  // Watchdog for a silently dead stream: the connection can look open while no
  // readings arrive (e.g. server restarted). The error it sets is surfaced by
  // the Sensors page.
  useEffect(() => {
    const healthCheck = setInterval(() => {
      if (state.lastUpdate && Date.now() - state.lastUpdate.getTime() > HEARTBEAT_STALE_MS) {
        setState((prev) => ({
          ...prev,
          connectionStatus: "offline",
          error: "No real-time data received for 30s",
          consecutiveFailures: prev.consecutiveFailures + 1,
        }));
        consecutiveFailuresRef.current += 1;
      }
    }, 10000);

    return () => clearInterval(healthCheck);
  }, [state.lastUpdate]);

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

// Threshold settings: fetch on mount, save with optimistic local update and a
// 2s "saved" confirmation.
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
    } catch (error) {
      if (isSessionExpired(error)) return Promise.reject(error);
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
    } catch (error) {
      if (isSessionExpired(error)) return Promise.reject(error);
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
      if (isSessionExpired(error)) return Promise.reject(error);
      setState((prev) => ({
        ...prev,
        logsLoading: false,
        logsError: "Failed to load logs",
      }));
    }
  }, []);

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

// Activity logs with pagination, search, sort, and action-type filter.
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
        10,
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
          activityLogsTotalPages: response.totalPages ?? Math.ceil((response.total || 0) / 10),
        }));
      }
    } catch (error) {
      if (isAxiosError(error) && error.code === "ERR_CANCELED") return;
      if (isSessionExpired(error)) return Promise.reject(error);
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

  // Fire-and-forget audit trail entry.
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
  // The selected tank lives here so it persists across pages. It defaults to
  // the first registered device, set from the fleet poll callback (not an
  // effect — that would cause cascading renders).
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  const handleDevicesLoaded = useCallback((devices: DeviceEntry[]) => {
    setSelectedDeviceId((current) => {
      if (!devices || devices.length === 0) return null;
      // Keep the current pick only if it is still in the visible fleet (e.g.
      // it wasn't just hidden); otherwise fall back to the first tank.
      if (current !== null && devices.some((d) => d.device_id === current)) return current;
      const first = [...devices].sort((a, b) => a.device_id.localeCompare(b.device_id))[0];
      return first.device_id;
    });
  }, []);

  const sensorData = useSensorDataPolling(selectedDeviceId, handleDevicesLoaded);
  const settingsState = useSettingsManager();
  const logsState = useLogsManager();
  const activityLogsState = useActivityLogsManager();

  const dataContextValue = useMemo(
    () => ({
      latestReading: sensorData.latestReading,
      history: sensorData.history,
      loading: sensorData.loading,
      error: sensorData.error,
      connectionStatus: sensorData.connectionStatus,
      lastUpdate: sensorData.lastUpdate,
      consecutiveFailures: sensorData.consecutiveFailures,
      historyStale: sensorData.historyStale,
      historyLastUpdated: sensorData.historyLastUpdated,
      devices: sensorData.devices,
      devicesLoading: sensorData.devicesLoading,
      selectedDeviceId,
      setSelectedDeviceId,
      refetch: sensorData.refetch,
    }),
    [sensorData, selectedDeviceId]
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
