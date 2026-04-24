import { createContext } from "react";
import type { SensorEntry, ChartPoint, LogEntry, SensorSettings } from "../types";

export type ConnectionStatus = "online" | "offline" | "connecting" | "unknown";

export interface SensorContextValue {
  data: SensorEntry | null;
  history: ChartPoint[];
  logs: LogEntry[];
  settings: SensorSettings | null;
  loading: boolean;
  error: string | null;
  connectionStatus: ConnectionStatus;
  lastUpdate: Date | null;
  consecutiveFailures: number;
  refetch: () => Promise<void>;
}

const defaultValue: SensorContextValue = {
  data: null,
  history: [],
  logs: [],
  settings: null,
  loading: true,
  error: null,
  connectionStatus: "unknown",
  lastUpdate: null,
  consecutiveFailures: 0,
  refetch: async () => {},
};

export const SensorContext = createContext<SensorContextValue>(defaultValue);