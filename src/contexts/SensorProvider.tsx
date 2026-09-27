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
import type { LogsDeviceMode } from "./SensorContext";
import type {
  SensorEntry,
  ChartPoint,
  LogEntry,
  SensorSettings,
  ActivityLog,
  ActivityActionType,
  DeviceEntry,
  DeviceLiveReading,
  DeviceThresholdOverrides,
  SensorThreshold,
} from "../types";
import { mergeThresholds, getSettingsThresholds } from "../types";
import {
  fetchLatestSensor,
  fetchSensorHistory,
  fetchLogs,
  fetchSettings,
  fetchEffectiveThresholds,
  fetchActivityLogs,
  fetchDevices,
  fetchDevicesLatest,
  logActivity as apiLogActivity,
  saveSettings as apiSaveSettings,
  saveDeviceThresholds as apiSaveDeviceThresholds,
  clearDeviceThresholds as apiClearDeviceThresholds,
} from "../api/client";

const HISTORY_POLL_INTERVAL = 30000;
const DEVICES_POLL_INTERVAL = 5000;
const LOGS_POLL_INTERVAL = 5000;
const LOGS_PAGE_SIZE = 10;

const HEARTBEAT_STALE_MS = 30000; // no heartbeat for 30s -> offline
const MAX_CONSECUTIVE_FAILURES = 5;
// Reconnect backoff ceiling. Attempts are unbounded (the stream must never be
// abandoned), so this also stops a dead backend from being hammered.
const SSE_MAX_RECONNECT_DELAY_MS = 30000;

// Selected-tank persistence: survives reloads and re-logins; validated against
// the live fleet on mount (an unknown id falls back to the first tank).
const SELECTED_TANK_STORAGE_KEY = "crayvings_selected_tank";

function readStoredSelectedTank(): string | null {
  try {
    return localStorage.getItem(SELECTED_TANK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSelectedTank(deviceId: string | null) {
  try {
    if (deviceId) {
      localStorage.setItem(SELECTED_TANK_STORAGE_KEY, deviceId);
    } else {
      localStorage.removeItem(SELECTED_TANK_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode) — selection stays session-only.
  }
}

// Which tank the dashboard opens on when no valid id is stored. Land on one
// that is actually reporting instead of the alphabetically first: an offline
// tank, or one whose probes have died, renders a frozen "No signal" dashboard
// that reads as broken hardware rather than a stale selection. Order: online
// first, then the most recently seen, then alphabetical so the choice is
// stable and predictable when the rest ties.
function pickDefaultTank(devices: DeviceEntry[]): DeviceEntry {
  return [...devices].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const aSeen = a.last_seen ? Date.parse(a.last_seen) : 0;
    const bSeen = b.last_seen ? Date.parse(b.last_seen) : 0;
    if (aSeen !== bSeen) return bSeen - aSeen;
    return a.device_id.localeCompare(b.device_id);
  })[0];
}

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
  latestByTank: Record<string, DeviceLiveReading>;
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
  logsDeviceMode: LogsDeviceMode;
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
    latestByTank: {},
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
      // One tick fetches both the fleet registry and the freshest reading per
      // tank — a single 5s poll now feeds the tank cards AND the fleet-wide
      // threshold-alert watcher (useThresholdAlert).
      const [devices, latest] = await Promise.all([
        fetchDevices(false, devicesAbortRef.current.signal),
        fetchDevicesLatest(devicesAbortRef.current.signal),
      ]);
      if (reqId !== devicesReqIdRef.current) return;
      const latestByTank: Record<string, DeviceLiveReading> = {};
      for (const row of latest) {
        latestByTank[row.device_id] = row;
      }
      setState((prev) => ({ ...prev, devices, latestByTank, devicesLoading: false }));
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
    setState((prev) => {
      // A slower path (the REST seed, a manual refetch) must never overwrite a
      // value SSE already delivered, or the tiles visibly jump backwards: the
      // seed's DB round-trip can resolve after a live frame. SSE frames carry
      // recv_at = server arrival time, so on a tie the live frame is kept.
      // An unparseable timestamp yields NaN, fails this comparison, and is
      // therefore still applied - the safe direction.
      if (prev.lastUpdate && sensorTime.getTime() < prev.lastUpdate.getTime()) {
        return prev;
      }
      return {
        ...prev,
        latestReading: reading,
        loading: false,
        error: null,
        connectionStatus: computeConnectionStatus(false, sensorTime),
        lastUpdate: sensorTime,
        consecutiveFailures: 0,
      };
    });
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
    let isOpen = false;

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
          isOpen = true;
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
              // Defense in depth: the server already filters the stream per
              // ?device_id, but never let another tank's reading overwrite
              // the selected tank's live tiles.
              if (selectedDeviceId && message.data.device_id && message.data.device_id !== selectedDeviceId) {
                return;
              }
              applyLatestReading(message.data);
              consecutiveFailuresRef.current = 0;
            }
          } catch {
            // Malformed frame — ignore it.
          }
        };

        es.onerror = () => {
          // The error path must always resolve `loading`. Previously it left
          // loading=true, so a blocked/failed SSE stream combined with a REST
          // seed that has no timestamp yet pinned the dashboard on grey
          // skeletons forever: no values, no error text, no recourse. A farm
          // operator standing at the tank saw a blank dashboard.
          isOpen = false;
          setState((prev) => ({
            ...prev,
            loading: false,
            connectionStatus: "offline",
            error: "Real-time connection lost. Attempting to reconnect...",
          }));
          es.close();

          // Retry FOREVER. The dashboard must heal itself after a backend
          // restart, a laptop that slept through one, or a network blip -
          // reloading the page is not an acceptable recovery path for a tank
          // operator. The previous 10-attempt cap abandoned the stream after
          // ~3 minutes and left the UI silently falling back to the 5s REST
          // poll, which reads as "the data stopped being realtime".
          reconnectAttempts += 1;
          const delay =
            Math.min(1000 * Math.pow(2, reconnectAttempts - 1), SSE_MAX_RECONNECT_DELAY_MS) +
            Math.random() * 1000;
          setState((prev) => ({
            ...prev,
            error: `Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${reconnectAttempts})`,
          }));

          reconnectTimeout = setTimeout(() => {
            connectSSE();
          }, delay);
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

    // Re-arm the moment the tab becomes visible, the browser regains network,
    // or the window regains focus. These are the paths a sleeping laptop or a
    // restarted backend actually take: the socket dies silently while the tab
    // is backgrounded, so on return nothing triggers a retry and the dashboard
    // sits on stale numbers until it is manually reloaded. No-op while the
    // stream is healthy, so ordinary focus changes cost nothing.
    const rearm = () => {
      if (document.visibilityState === "hidden") return;
      if (isOpen) return;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      connectSSE();
    };
    document.addEventListener("visibilitychange", rearm);
    window.addEventListener("online", rearm);
    window.addEventListener("focus", rearm);

    // Seed the latest reading via REST so a freshly opened dashboard has data
    // before the next device POST arrives. applyLatestReading drops this if a
    // live SSE frame has already arrived, so the seed can never rewind a value.
    fetchLatestSensor(selectedDeviceId)
      .then((result) => {
        if (result.data && result.data.timestamp) applyLatestReading(result.data);
      })
      .catch(() => {
        // SSE will deliver readings once the device posts.
      });

    return () => {
      isOpen = false;
      document.removeEventListener("visibilitychange", rearm);
      window.removeEventListener("online", rearm);
      window.removeEventListener("focus", rearm);
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

// Threshold settings: global (farm default) row + per-tank overrides layered
// on top. Fetch on mount, save with optimistic local update and a 2s "saved"
// confirmation. thresholdsFor returns identity-stable maps so consumers can
// diff them to detect edits (vs. a sensor crossing).
interface SensorSettingsState {
  settings: SensorSettings | null;
  deviceOverrides: DeviceThresholdOverrides;
  settingsLoading: boolean;
  settingsError: string | null;
  saveError: string | null;
  settingsSaved: boolean;
  settingsSaving: boolean;
}

function useSettingsManager(): SensorSettingsState & {
  refetch: () => void;
  save: (s: Partial<SensorSettings>) => Promise<void>;
  saveDeviceThresholds: (deviceId: string, override: Partial<SensorSettings>) => Promise<void>;
  clearDeviceThresholds: (deviceId: string) => Promise<void>;
  settingsFor: (deviceId?: string | null) => SensorSettings | null;
  thresholdsFor: (deviceId?: string | null) => Record<string, SensorThreshold>;
} {
  const [state, setState] = useState<SensorSettingsState>({
    settings: null,
    deviceOverrides: {},
    settingsLoading: true,
    settingsError: null,
    saveError: null,
    settingsSaved: false,
    settingsSaving: false,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashSaved = useCallback(() => {
    if (savedTimeoutRef.current) {
      clearTimeout(savedTimeoutRef.current);
    }
    savedTimeoutRef.current = setTimeout(() => {
      setState((prev) => ({ ...prev, settingsSaved: false }));
    }, 2000);
  }, []);

  const fetchData = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      // The overrides map is best-effort: an older backend without
      // /settings/effective just means "every tank inherits global".
      const [settings, effective] = await Promise.all([
        fetchSettings(abortControllerRef.current.signal),
        fetchEffectiveThresholds(abortControllerRef.current.signal).catch(() => null),
      ]);
      setState((prev) => ({
        ...prev,
        settings,
        deviceOverrides: effective?.devices ?? {},
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
      flashSaved();
    } catch (error) {
      if (isSessionExpired(error)) return Promise.reject(error);
      setState((prev) => ({
        ...prev,
        settingsSaving: false,
        saveError: "Failed to save settings",
      }));
    }
  }, [flashSaved]);

  const saveDeviceThresholds = useCallback(async (deviceId: string, override: Partial<SensorSettings>) => {
    setState((prev) => ({ ...prev, settingsSaving: true, saveError: null }));
    try {
      await apiSaveDeviceThresholds(deviceId, override);
      const effective = await fetchEffectiveThresholds().catch(() => null);
      setState((prev) => ({
        ...prev,
        settingsSaving: false,
        settingsSaved: true,
        deviceOverrides: effective?.devices ?? prev.deviceOverrides,
      }));
      flashSaved();
    } catch (error) {
      if (isSessionExpired(error)) return Promise.reject(error);
      setState((prev) => ({
        ...prev,
        settingsSaving: false,
        saveError: "Failed to save tank thresholds",
      }));
    }
  }, [flashSaved]);

  const clearDeviceThresholds = useCallback(async (deviceId: string) => {
    setState((prev) => ({ ...prev, settingsSaving: true, saveError: null }));
    try {
      await apiClearDeviceThresholds(deviceId);
      setState((prev) => {
        const next = { ...prev.deviceOverrides };
        delete next[deviceId];
        return { ...prev, settingsSaving: false, settingsSaved: true, deviceOverrides: next };
      });
      flashSaved();
    } catch (error) {
      if (isSessionExpired(error)) return Promise.reject(error);
      setState((prev) => ({
        ...prev,
        settingsSaving: false,
        saveError: "Failed to clear tank thresholds",
      }));
    }
  }, [flashSaved]);

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, settingsLoading: true, settingsError: null, saveError: null }));
    fetchData();
  }, [fetchData]);

  // Merged effective row for one tank (global row + that tank's override).
  const settingsFor = useCallback(
    (deviceId?: string | null): SensorSettings | null =>
      deviceId ? mergeThresholds(state.settings, state.deviceOverrides[deviceId]) : state.settings,
    [state.settings, state.deviceOverrides]
  );

  // Identity-stable threshold maps: a given (settings, overrides) pair always
  // returns the same object, so useThresholdAlert can detect real edits.
  const globalThresholds = useMemo(
    () => getSettingsThresholds(state.settings),
    [state.settings]
  );
  const thresholdsByDevice = useMemo(() => {
    const map = new Map<string, Record<string, SensorThreshold>>();
    for (const [id, override] of Object.entries(state.deviceOverrides)) {
      map.set(id, getSettingsThresholds(mergeThresholds(state.settings, override)));
    }
    return map;
  }, [state.settings, state.deviceOverrides]);

  const thresholdsFor = useCallback(
    (deviceId?: string | null): Record<string, SensorThreshold> =>
      (deviceId ? thresholdsByDevice.get(deviceId) : undefined) ?? globalThresholds,
    [thresholdsByDevice, globalThresholds]
  );

  return useMemo(
    () => ({
      ...state,
      refetch,
      save,
      saveDeviceThresholds,
      clearDeviceThresholds,
      settingsFor,
      thresholdsFor,
    }),
    [state, refetch, save, saveDeviceThresholds, clearDeviceThresholds, settingsFor, thresholdsFor]
  );
}

// Paginated system logs, auto-polled every 5s. The device filter has three
// modes: "follow" (the globally selected tank — the default, so switching
// tanks in the header instantly re-scopes the Alerts/Logs pages), "all"
// (every tank incl. farm-wide rows), or a specific device id.
function useLogsManager(selectedDeviceId: string | null): LogsState & {
  refetch: () => void;
  setPage: (page: number) => void;
  setLogsActionFilter: (filter: string) => void;
  setLogsParameterFilter: (filter: string) => void;
  setLogsDeviceMode: (mode: LogsDeviceMode) => void;
} {
  const [state, setState] = useState<LogsState>({
    logs: [],
    logsLoading: true,
    logsError: null,
    logsPage: 1,
    logsTotal: 0,
    logsCounts: {},
    logsActionFilter: "",
    logsParameterFilter: "",
    logsDeviceMode: "follow",
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  // "follow" resolves to the selected tank at fetch time.
  const resolvedDeviceId =
    state.logsDeviceMode === "follow"
      ? selectedDeviceId
      : state.logsDeviceMode === "all"
        ? null
        : state.logsDeviceMode;

  const fetchData = useCallback(async (page = 1, actionFilter = "", parameterFilter = "", deviceId?: string | null) => {
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
          device_id: deviceId || undefined,
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
    fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter, resolvedDeviceId);
    const interval = setInterval(
      () => {
        if (!document.hidden) fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter, resolvedDeviceId);
      },
      LOGS_POLL_INTERVAL
    );

    return () => {
      clearInterval(interval);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData, state.logsPage, state.logsActionFilter, state.logsParameterFilter, resolvedDeviceId]);

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, logsLoading: true, logsError: null }));
    fetchData(state.logsPage, state.logsActionFilter, state.logsParameterFilter, resolvedDeviceId);
  }, [fetchData, state.logsPage, state.logsActionFilter, state.logsParameterFilter, resolvedDeviceId]);

  const setPage = useCallback((page: number) => {
    setState((prev) => ({ ...prev, logsPage: page }));
  }, []);

  const setLogsActionFilter = useCallback((filter: string) => {
    setState((prev) => ({
      ...prev,
      logsActionFilter: filter,
      logsPage: 1,
    }));
    fetchData(1, filter, state.logsParameterFilter, resolvedDeviceId);
  }, [fetchData, state.logsParameterFilter, resolvedDeviceId]);

  const setLogsParameterFilter = useCallback((filter: string) => {
    setState((prev) => ({
      ...prev,
      logsParameterFilter: filter,
      logsPage: 1,
    }));
    fetchData(1, state.logsActionFilter, filter, resolvedDeviceId);
  }, [fetchData, state.logsActionFilter, resolvedDeviceId]);

  const setLogsDeviceMode = useCallback((mode: LogsDeviceMode) => {
    setState((prev) => ({
      ...prev,
      logsDeviceMode: mode,
      logsPage: 1,
    }));
    const deviceId = mode === "follow" ? selectedDeviceId : mode === "all" ? null : mode;
    fetchData(1, state.logsActionFilter, state.logsParameterFilter, deviceId);
  }, [fetchData, state.logsActionFilter, state.logsParameterFilter, selectedDeviceId]);

  return useMemo(
    () => ({
      ...state,
      refetch,
      setPage,
      setLogsActionFilter,
      setLogsParameterFilter,
      setLogsDeviceMode,
    }),
    [state, refetch, setPage, setLogsActionFilter, setLogsParameterFilter, setLogsDeviceMode]
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
  // The selected tank lives here so it persists across pages AND across
  // reloads/re-logins (localStorage). When nothing valid is stored it defaults
  // to a tank that is actually reporting (see pickDefaultTank), set from the
  // fleet poll callback (not an effect — that would cause cascading renders).
  // An unknown stored id (tank removed/hidden) is re-picked the same way.
  const [selectedDeviceId, setSelectedDeviceIdState] = useState<string | null>(readStoredSelectedTank);

  const setSelectedDeviceId = useCallback((deviceId: string | null) => {
    setSelectedDeviceIdState(deviceId);
    writeStoredSelectedTank(deviceId);
  }, []);

  const handleDevicesLoaded = useCallback((devices: DeviceEntry[]) => {
    setSelectedDeviceIdState((current) => {
      if (!devices || devices.length === 0) {
        if (current !== null) writeStoredSelectedTank(null);
        return null;
      }
      // Keep the current pick only if it is still in the visible fleet (e.g.
      // it wasn't just hidden); otherwise fall back to a tank that is actually
      // reporting. Picking alphabetically meant landing on ESP32_01 purely
      // because "0" < "1" < "2", even though that tank's DS18B20 and HC-SR04
      // were dead and the operator's own live tank was ignored.
      if (current !== null && devices.some((d) => d.device_id === current)) return current;
      const first = pickDefaultTank(devices);
      writeStoredSelectedTank(first.device_id);
      return first.device_id;
    });
  }, []);

  const sensorData = useSensorDataPolling(selectedDeviceId, handleDevicesLoaded);
  const settingsState = useSettingsManager();
  const logsState = useLogsManager(selectedDeviceId);
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
      latestByTank: sensorData.latestByTank,
      selectedDeviceId,
      setSelectedDeviceId,
      refetch: sensorData.refetch,
    }),
    [sensorData, selectedDeviceId, setSelectedDeviceId]
  );

  const settingsContextValue = useMemo(
    () => ({
      settings: settingsState.settings,
      deviceOverrides: settingsState.deviceOverrides,
      settingsFor: settingsState.settingsFor,
      thresholdsFor: settingsState.thresholdsFor,
      settingsLoading: settingsState.settingsLoading,
      settingsError: settingsState.settingsError,
      saveError: settingsState.saveError,
      refetchSettings: settingsState.refetch,
      saveSettings: settingsState.save,
      saveDeviceThresholds: settingsState.saveDeviceThresholds,
      clearDeviceThresholds: settingsState.clearDeviceThresholds,
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
      logsDeviceMode: logsState.logsDeviceMode,
      setLogsDeviceMode: logsState.setLogsDeviceMode,
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
