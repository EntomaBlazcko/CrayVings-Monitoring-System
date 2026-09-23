// =============================================================================
// FILE: src/hooks/useSSE.ts
// PURPOSE: Server-Sent Events hook for real-time sensor data
// =============================================================================

import { useEffect, useRef, useState, useCallback } from "react";
import type { SensorEntry } from "../types";

interface UseSSEReturn {
  data: SensorEntry | null;
  connectionStatus: "connecting" | "open" | "closed";
  error: string | null;
  reconnect: () => void;
}

export function useSSE(deviceId?: string | null): UseSSEReturn {
  const [data, setData] = useState<SensorEntry | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 10;
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setConnectionStatus("connecting");
    setError(null);

    const baseUrl = import.meta.env.VITE_API_BASE || "http://localhost:3000";
    // EventSource cannot set Authorization headers, so the JWT is passed as
    // a query parameter (authenticateToken accepts it for SSE streams).
    const params = new URLSearchParams();
    const token = localStorage.getItem("crayvings_token");
    if (token) params.set("token", token);
    if (deviceId) params.set("device_id", deviceId);
    const url = `${baseUrl}/sensor/stream${params.toString() ? `?${params.toString()}` : ""}`;

    try {
      const es = new EventSource(url, { withCredentials: true });
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnectionStatus("open");
        reconnectAttemptsRef.current = 0;
        setError(null);
      };

      es.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "sensor_update" && message.data) {
            setData(message.data);
          }
        } catch (err) {
          console.warn("Failed to parse SSE message:", err);
        }
      };

      es.onerror = () => {
        setConnectionStatus("closed");
        es.close();

        // Exponential backoff reconnection
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000) + Math.random() * 1000;
          reconnectAttemptsRef.current++;
          setError(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            connectRef.current();
          }, delay);
        } else {
          setError("Max reconnection attempts reached. Please refresh the page.");
        }
      };
    } catch {
      setError("Failed to establish SSE connection");
      setConnectionStatus("closed");
    }
  }, [deviceId]);

  // Update ref when connect changes
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connectRef.current();
  }, []);

  useEffect(() => {
    connectRef.current();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  return { data, connectionStatus, error, reconnect };
}