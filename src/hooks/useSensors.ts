import { useContext } from "react";
import { SensorContext, type SensorContextValue } from "../contexts/SensorContext";

export function useSensors(): SensorContextValue {
  const context = useContext(SensorContext);
  if (!context) {
    throw new Error("useSensors must be used within a SensorProvider");
  }
  return context;
}

export function useSensorSettings() {
  const { settings, loading } = useSensors();
  return { settings, loading };
}

export function useConnectionStatus() {
  const { connectionStatus, lastUpdate, consecutiveFailures } = useSensors();
  return { connectionStatus, lastUpdate, consecutiveFailures };
}