// =============================================================================
// FILE: src/hooks/useFloatingAlerts.ts
// =============================================================================
// Context and hook for managing floating toast notifications.
// =============================================================================

import { createContext, useContext } from "react";

interface AlertNotification {
  id: string;
  message: string;
  type: "warning" | "critical";
  parameter: string;
  value: number;
  threshold: "min" | "max";
}

interface FloatingAlertContextType {
  notifications: AlertNotification[];
  addNotification: (notification: Omit<AlertNotification, "id">) => Promise<void>;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
}

export const FloatingAlertContext = createContext<FloatingAlertContextType | null>(null);

// Throws if used outside FloatingAlertProvider.
export function useFloatingAlerts() {
  const context = useContext(FloatingAlertContext);
  if (!context) {
    throw new Error("useFloatingAlerts must be used within FloatingAlertProvider");
  }
  return context;
}

export type { AlertNotification, FloatingAlertContextType };
