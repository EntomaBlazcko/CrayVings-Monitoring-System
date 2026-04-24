import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { SensorContext, type ConnectionStatus } from "./SensorContext";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings } from "../types";
import * as api from "../api/client";

const POLL_INTERVAL = 3000;
const OFFLINE_THRESHOLD = 15000;
const MAX_CONSECUTIVE_FAILURES = 5;

export function SensorProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<SensorEntry | null>(null);
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [settings, setSettings] = useState<SensorSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const wasOfflineRef = useRef(false);

  const connectionStatus: ConnectionStatus = (() => {
    if (loading) return "connecting";
    if (!lastUpdate) return "unknown";
    const gap = Date.now() - lastUpdate.getTime();
    if (gap > OFFLINE_THRESHOLD) return "offline";
    return "online";
  })();

  const fetchData = useCallback(async () => {
    try {
      const [latest, historyData] = await Promise.all([
        api.fetchLatestSensor(),
        api.fetchSensorHistory(50),
      ]);

      if (latest) {
        setData(latest);
        setHistory(historyData);
        setLastUpdate(new Date());
        setConsecutiveFailures(0);
        setError(null);

        if (wasOfflineRef.current) {
          console.log("Device reconnected!");
          wasOfflineRef.current = false;
        }
      } else {
        setData(null);
        setHistory([]);
        setError("No sensor data available");
      }
    } catch {
      const newFailures = consecutiveFailures + 1;
      setConsecutiveFailures(newFailures);

      if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
        setError("Unable to connect to device. Device may be offline.");
        wasOfflineRef.current = true;
      }
    } finally {
      setLoading(false);
    }
  }, [consecutiveFailures]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    api.fetchSettings().then(setSettings).catch(console.error);
  }, []);

  useEffect(() => {
    api.fetchLogs().then(setLogs).catch(console.error);
  }, []);

  return (
    <SensorContext.Provider
      value={{
        data,
        history,
        logs,
        settings,
        loading,
        error,
        connectionStatus,
        lastUpdate,
        consecutiveFailures,
        refetch: fetchData,
      }}
    >
      {children}
    </SensorContext.Provider>
  );
}