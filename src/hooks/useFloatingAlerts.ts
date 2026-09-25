import { createContext, useContext } from "react";
import type { SensorSettings } from "../types";

interface AlertNotification {
  id: string;
  message: string;
  type: "warning" | "critical";
  parameter: string;
  value: number;
  threshold: "min" | "max";
  // Tank attribution for fleet-wide alerting: toasts for different tanks are
  // deduped independently and can show a tank badge. Undefined = farm-wide.
  deviceId?: string;
  tank?: string;
  // The breaching tank's EFFECTIVE settings (global + per-tank override) so
  // the "Fix?" guidance shows the correct safe range for that tank.
  settings?: SensorSettings | null;
}

interface FloatingAlertContextType {
  notifications: AlertNotification[];
  addNotification: (notification: Omit<AlertNotification, "id">) => Promise<void>;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
}

export const FloatingAlertContext = createContext<FloatingAlertContextType | null>(null);

export function useFloatingAlerts() {
  const context = useContext(FloatingAlertContext);
  if (!context) {
    throw new Error("useFloatingAlerts must be used within FloatingAlertProvider");
  }
  return context;
}

export type { AlertNotification, FloatingAlertContextType };