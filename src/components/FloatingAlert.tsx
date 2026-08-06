// =============================================================================
// FILE: src/components/FloatingAlert.tsx
// =============================================================================
// PURPOSE: Floating toast notification system for real-time alerts.
//
// This file provides:
//   - FloatingAlertProvider: Context provider that manages notification state
//   - FloatingAlertContainer: Renders all active notifications in the top-right
//   - FloatingAlertItem: Individual notification card with auto-dismiss and
//     mute options for device disconnect alerts
//
// NOTIFICATION BEHAVIOR:
//   - Auto-dismiss after 5 seconds with a slide-out animation
//   - Play alert sound when added (low for min threshold, high for max)
//   - Device disconnect notifications show SMS mute options
//   - Multiple notifications can be displayed simultaneously
//   - Duplicate notifications for the same sensor+threshold are replaced
//
// MOUNTED IN: App.tsx (always visible, outside page routing)
// =============================================================================

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { X, AlertTriangle, AlertCircle, BellOff } from "lucide-react";
import { playLowAlertSound, playHighAlertSound } from "../utils/playAlertSound";
import { muteAlerts } from "../api/client";
import { 
  FloatingAlertContext, 
  useFloatingAlerts,
  type AlertNotification
} from "../hooks/useFloatingAlerts";

// Available mute durations in hours for SMS alert silencing
const MUTE_OPTIONS = [1, 2, 4, 6, 8, 12, 24];

interface FloatingAlertProviderProps {
  children: ReactNode;
}

// ========================
// FLOATING ALERT PROVIDER
// ========================
/**
 * Context provider that manages the floating notification state.
 * Handles adding notifications (with sound), removing them, and clearing all.
 * Plays appropriate alert sounds based on threshold direction (min/max).
 */
export function FloatingAlertProvider({ children }: FloatingAlertProviderProps) {
  const [notifications, setNotifications] = useState<AlertNotification[]>([]);

  /**
   * Plays the appropriate alert sound based on threshold type.
   * Low threshold = lower pitch, high threshold = higher pitch.
   */
  const playAlertSound = useCallback(async (threshold: "min" | "max") => {
    try {
      if (threshold === "min") {
        await playLowAlertSound();
      } else {
        await playHighAlertSound();
      }
    } catch {
      // Silent fail - audio may not work (browser policy)
    }
  }, []);

  /**
   * Adds a new notification to the display.
   * Plays sound BEFORE updating state so sound isn't delayed by React rendering.
   * Replaces any existing notification for the same sensor+threshold.
   * Skips sound for device notifications (sound is handled by DeviceConnectionMonitor).
   */
  const addNotification = useCallback(async (notification: Omit<AlertNotification, "id">) => {
    const id = `${notification.parameter}-${notification.threshold}-${Date.now()}`;
    
    // Play sound FIRST before updating state (skip for device notifications - sound handled elsewhere)
    if (notification.parameter !== "device") {
      await playAlertSound(notification.threshold);
    }
    
    // Always add new notification (allow multiple same alerts)
    setNotifications((prev) => {
      // Remove old notification for same sensor if exists (replace with newer one)
      const filtered = prev.filter(
        (n) => !(n.parameter === notification.parameter && n.threshold === notification.threshold)
      );
      return [...filtered, { ...notification, id }];
    });
  }, [playAlertSound]);

  /** Removes a specific notification by ID. */
  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  /** Clears all active notifications. */
  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  return (
    <FloatingAlertContext.Provider value={{ notifications, addNotification, removeNotification, clearNotifications }}>
      {children}
    </FloatingAlertContext.Provider>
  );
}

// ========================
// FLOATING ALERT CONTAINER
// ========================
/**
 * Renders all active notifications as a vertical stack in the top-right corner.
 * Positioned with fixed positioning and high z-index to stay on top of all content.
 */
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

// ========================
// FLOATING ALERT ITEM
// ========================
/**
 * Individual notification card component.
 * Features:
 *   - Auto-dismisses after 5 seconds with a slide-out animation
 *   - Shows warning or critical styling based on notification type
 *   - Device disconnect alerts include SMS mute options
 *   - Close button for manual dismissal
 */
interface FloatingAlertItemProps {
  notification: AlertNotification;
  onClose: () => void;
}

function FloatingAlertItem({ notification, onClose }: FloatingAlertItemProps) {
  const [isExiting, setIsExiting] = useState(false);
  const [showMuteOptions, setShowMuteOptions] = useState(false);
  const [muting, setMuting] = useState(false);

  // Keep the latest onClose in a ref so the auto-dismiss timer below is not
  // torn down and restarted on every parent re-render (which would prevent
  // notifications from ever auto-dismissing).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Auto-dismiss after 5 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(() => onCloseRef.current(), 300);
    }, 5000);

    return () => clearTimeout(timer);
  }, [notification.id]);

  // Manual close with exit animation
  const handleClose = () => {
    setIsExiting(true);
    setTimeout(onClose, 300);
  };

  /** Mutes SMS alerts for the specified number of hours. */
  const handleMute = useCallback(async (hours: number) => {
    setMuting(true);
    await muteAlerts(hours);
    setMuting(false);
    setShowMuteOptions(false);
    setIsExiting(true);
    setTimeout(onClose, 300);
  }, [onClose]);

  // Dynamic styling based on notification severity
  const isWarning = notification.type === "warning";
  const bgColor = isWarning ? "bg-amber-50" : "bg-red-50";
  const borderColor = isWarning ? "border-amber-300" : "border-red-400";
  const iconColor = isWarning ? "text-amber-500" : "text-red-500";
  const textColor = isWarning ? "text-amber-800" : "text-red-800";

  return (
    <div
      className={`
        pointer-events-auto flex flex-col gap-2 p-3 rounded-lg border shadow-lg
        ${bgColor} ${borderColor}
        transition-all duration-300 ease-out
        ${isExiting ? "opacity-0 translate-x-full" : "opacity-100 translate-x-0"}
      `}
    >
      {/* Notification content: icon, message, close button */}
      <div className="flex items-start gap-3">
        <div className={`flex-shrink-0 ${iconColor}`}>
          {isWarning ? <AlertTriangle size={18} /> : <AlertCircle size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium ${textColor} break-words`}>
            {notification.message}
          </p>
          {/* Show sensor value details (hide for device connection alerts) */}
          {notification.parameter !== "device" && (
            <p className="text-xs text-gray-500 mt-0.5">
              Current: {notification.value} - Threshold: {notification.threshold === "min" ? "below min" : "above max"}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center gap-1">
          {/* SMS mute button - only shown for device disconnect alerts */}
          {notification.parameter === "device" && (
            <button
              onClick={() => setShowMuteOptions(!showMuteOptions)}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              title="Mute SMS alerts"
            >
              <BellOff size={16} />
            </button>
          )}
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* SMS mute options panel - expandable when bell icon is clicked */}
      {showMuteOptions && (
        <div className="flex flex-wrap gap-1 pt-1 border-t border-gray-200/50">
          <span className="text-xs text-gray-500 w-full mb-1">Mute SMS alerts for:</span>
          {MUTE_OPTIONS.map((hours) => (
            <button
              key={hours}
              onClick={() => handleMute(hours)}
              disabled={muting}
              className="px-2 py-1 text-xs font-medium rounded bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              {hours}h
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default FloatingAlertContainer;
