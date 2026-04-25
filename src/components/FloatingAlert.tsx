import { useState, useEffect, createContext, useContext, useCallback, type ReactNode } from "react";
import { X, AlertTriangle, AlertCircle } from "lucide-react";
import { playLowAlertSound, playHighAlertSound } from "../utils/playAlertSound";

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
  addNotification: (notification: Omit<AlertNotification, "id">) => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
}

const FloatingAlertContext = createContext<FloatingAlertContextType | null>(null);

export function useFloatingAlerts() {
  const context = useContext(FloatingAlertContext);
  if (!context) {
    throw new Error("useFloatingAlerts must be used within FloatingAlertProvider");
  }
  return context;
}

interface FloatingAlertProviderProps {
  children: ReactNode;
}

export function FloatingAlertProvider({ children }: FloatingAlertProviderProps) {
  const [notifications, setNotifications] = useState<AlertNotification[]>([]);

  const addNotification = useCallback((notification: Omit<AlertNotification, "id">) => {
    const id = `${notification.parameter}-${notification.threshold}-${Date.now()}`;
    setNotifications((prev) => {
      const exists = prev.some(
        (n) => n.parameter === notification.parameter && n.threshold === notification.threshold
      );
      if (exists) return prev;
      
      if (notification.threshold === "min") {
        playLowAlertSound();
      } else {
        playHighAlertSound();
      }
      
      return [...prev, { ...notification, id }];
    });
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  return (
    <FloatingAlertContext.Provider value={{ notifications, addNotification, removeNotification, clearNotifications }}>
      {children}
    </FloatingAlertContext.Provider>
  );
}

export function FloatingAlertContainer() {
  const { notifications, removeNotification } = useFloatingAlerts();

  return (
    <div className="fixed top-20 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
      {notifications.map((notification) => (
        <FloatingAlertItem
          key={notification.id}
          notification={notification}
          onClose={() => removeNotification(notification.id)}
        />
      ))}
    </div>
  );
}

interface FloatingAlertItemProps {
  notification: AlertNotification;
  onClose: () => void;
}

function FloatingAlertItem({ notification, onClose }: FloatingAlertItemProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onClose, 300);
    }, 5000);

    return () => clearTimeout(timer);
  }, [onClose]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(onClose, 300);
  };

  const isWarning = notification.type === "warning";
  const bgColor = isWarning ? "bg-amber-50" : "bg-red-50";
  const borderColor = isWarning ? "border-amber-300" : "border-red-400";
  const iconColor = isWarning ? "text-amber-500" : "text-red-500";
  const textColor = isWarning ? "text-amber-800" : "text-red-800";

  return (
    <div
      className={`
        pointer-events-auto flex items-start gap-3 p-3 rounded-lg border shadow-lg
        ${bgColor} ${borderColor}
        transition-all duration-300 ease-out
        ${isExiting ? "opacity-0 translate-x-full" : "opacity-100 translate-x-0"}
      `}
    >
      <div className={`flex-shrink-0 ${iconColor}`}>
        {isWarning ? <AlertTriangle size={18} /> : <AlertCircle size={18} />}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${textColor} break-words`}>
          {notification.message}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">
          Current: {notification.value} • Threshold: {notification.threshold === "min" ? "below min" : "above max"}
        </p>
      </div>
      <button
        onClick={handleClose}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export default FloatingAlertContainer;