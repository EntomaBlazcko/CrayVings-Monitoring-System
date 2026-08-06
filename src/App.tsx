// =============================================================================
// FILE: src/App.tsx
// =============================================================================
// PURPOSE: Root application component with routing, layout, and providers.
//
// This file is the top-level component that:
//   1. Wraps the entire app in context providers (Auth, Sensor, FloatingAlert)
//   2. Manages navigation state (which page is currently active)
//   3. Renders the sidebar navigation and page content based on active menu
//   4. Handles authentication flow (shows AuthPage if not logged in)
//   5. Persists the last viewed page in localStorage
//   6. Logs navigation events for activity tracking
//
// LAYOUT STRUCTURE:
//   App (outermost)
//   └── AuthProvider (manages login/logout state)
//       └── SensorProvider (manages sensor data, settings, logs)
//           └── FloatingAlertProvider (manages toast notifications)
//               ├── AppContent (auth check: shows AuthPage or DashboardLayout)
//               ├── FloatingAlertContainer (toast notification display)
//               └── DeviceConnectionMonitor (ESP32 connection watcher)
//
// NAVIGATION:
//   Uses client-side state (useState) instead of react-router.
//   The activeMenu state determines which page component to render.
//   Menu items are defined in baseMenuItems array.
// =============================================================================

import { useState, useCallback, useRef, useMemo } from "react";
import {
  Menu,
  X,
  Home,
  LayoutDashboard,
  Activity,
  Bell,
  History,
  Settings,
  FileText,
  ClipboardList,
} from "lucide-react";
import logo from "./assets/crayvings.png";
import type { MenuKey } from "./types";
import { isValidMenuKey } from "./types";
import Header from "./components/Header";
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import SensorsPage from "./pages/SensorsPage";
import AlertsPage from "./pages/AlertsPage";
import HistoricalDataPage from "./pages/HistoricalDataPage";
import SettingsPage from "./pages/SettingsPage";
import LogsPage from "./pages/LogsPage";
import ActivityLogsPage from "./pages/ActivityLogsPage";
import AuthPage from "./pages/AuthPage";
import { SensorProvider } from "./contexts/SensorProvider";
import { useActivityLogs } from "./contexts/SensorContext";
import { AuthProvider } from "./contexts/AuthContext";
import { useAuth } from "./contexts/useAuth";
import { DeviceConnectionMonitor } from "./components/DeviceConnectionMonitor";
import { FloatingAlertProvider, FloatingAlertContainer } from "./components/FloatingAlert";
import { useThresholdAlert } from "./hooks/useThresholdAlert";

// ========================
// NAVIGATION MENU DEFINITION
// ========================
// Defines all available pages with their labels and icons.
// Each label must match a valid MenuKey from types/index.ts.
const baseMenuItems: { label: MenuKey; icon: React.ReactNode }[] = [
  { label: "Home", icon: <Home size={18} /> },
  { label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { label: "Sensors", icon: <Activity size={18} /> },
  { label: "Alerts", icon: <Bell size={18} /> },
  { label: "Historical Data", icon: <History size={18} /> },
  { label: "Activity Logs", icon: <ClipboardList size={18} /> },
  { label: "Sensor Logs", icon: <FileText size={18} /> },
  { label: "Settings", icon: <Settings size={18} /> },
];

// ========================
// LOCAL STORAGE STATE RESTORATION
// ========================
/**
 * Restores the previously active menu from localStorage.
 * Falls back to "Home" if no saved state or the saved value is invalid.
 * This allows the app to remember the user's last viewed page across refreshes.
 */
function getInitialMenuDefault(): MenuKey {
  const saved = localStorage.getItem("activeMenu");
  if (saved && isValidMenuKey(saved)) {
    return saved;
  }
  return "Home";
}

// ========================
// DASHBOARD LAYOUT COMPONENT
// ========================
/**
 * Main dashboard layout with sidebar navigation and page content area.
 * Only rendered when the user is authenticated (useAuth returns a user).
 *
 * Features:
 *   - Responsive sidebar (collapsible on mobile with hamburger menu)
 *   - Page title display based on active menu
 *   - Navigation logging for activity tracking
 *   - localStorage persistence of active menu selection
 *   - Threshold alert monitoring hook
 */
function DashboardLayout() {
  const { user, logout } = useAuth();
  const { logActivity } = useActivityLogs();
  const previousMenuRef = useRef<MenuKey>("Home");
  const activeMenuRef = useRef<MenuKey>(getInitialMenuDefault());
  const [activeMenu, setActiveMenu] = useState<MenuKey>(getInitialMenuDefault);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  // Activate threshold monitoring - checks sensor readings against limits
  // and displays floating alerts when values go out of range
  useThresholdAlert();

  // Memoized menu items to prevent unnecessary re-renders
  const menuItems = useMemo(
    () => baseMenuItems,
    []
  );

  /**
   * Handles navigation between pages.
   * Logs the navigation event, updates state, persists to localStorage,
   * and closes the mobile sidebar.
   */
  const handleNavigate = useCallback((menu: MenuKey) => {
    const prev = activeMenuRef.current;
    logActivity("navigation", `Navigated to ${menu}`, prev);
    previousMenuRef.current = prev;
    activeMenuRef.current = menu;
    setActiveMenu(menu);
    localStorage.setItem("activeMenu", menu);
    setSidebarOpen(false);
  }, [logActivity]);

  /**
   * Renders the appropriate page component based on activeMenu state.
   * This is a manual routing approach (no react-router).
   * Each case renders a different page component.
   */
  const renderPage = useCallback(() => {
    switch (activeMenu) {
      case "Home":
        return <HomePage onNavigate={handleNavigate} />;
      case "Dashboard":
        return <DashboardPage />;
      case "Sensors":
        return <SensorsPage />;
      case "Alerts":
        return <AlertsPage />;
      case "Historical Data":
        return <HistoricalDataPage />;
      case "Activity Logs":
        return <ActivityLogsPage />;
      case "Sensor Logs":
        return <LogsPage />;
       case "Settings":
         return <SettingsPage />;
       default:
        return <HomePage onNavigate={handleNavigate} />;
    }
  }, [activeMenu, handleNavigate]);

  // Don't render anything if no user is authenticated
  if (!user) return null;

  return (
    <div className="flex min-h-screen bg-gray-100 font-sans">
      {/* Mobile hamburger menu button - only visible on small screens */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed top-4 left-4 z-50 p-2 bg-white rounded-lg shadow-lg md:hidden"
      >
        {sidebarOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      {/* Mobile overlay - darkens background when sidebar is open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar navigation - slides in on mobile, always visible on desktop */}
      <div
        className={`fixed md:static inset-y-0 left-0 z-50 w-24 bg-[#f5efe9] border-r border-[#eadfd6] min-h-screen flex flex-col items-center pt-4 transform transition-transform duration-300 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        {/* App logo at the top of the sidebar */}
        <div className="w-14 h-14 rounded-full bg-white flex items-center justify-center overflow-hidden border-2 border-[#e9d3c6] mb-4">
          <img
            src={logo}
            alt="Logo"
            className="w-full h-full object-contain"
          />
        </div>

        {/* Navigation menu buttons */}
        <div className="w-full flex flex-col gap-1 px-2">
          {menuItems.map((item) => {
            const isActive = activeMenu === item.label;

            return (
              <button
                key={item.label}
                onClick={() => handleNavigate(item.label)}
                className={`flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-lg text-[10px] font-semibold text-center cursor-pointer border-none w-full transition-colors ${
                  isActive
                    ? "bg-[#ffe7d6] text-[#c2410c] font-bold"
                    : "text-[#9a6b57] hover:bg-[#f8e7db]"
                }`}
              >
                {item.icon}
                <span className="leading-tight">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main content area: header + page content */}
      <div className="flex-1 flex flex-col w-full md:w-auto">
        {/* Top header bar with user info and logout button */}
        <Header user={user} onLogout={() => {
          logActivity("logout", `${user.name} logged out`, "Auth");
          logout();
        }} />

        {/* Page content container */}
        <div className="p-3 md:p-5">
          {/* Page title */}
          <div className="text-xl md:text-2xl font-extrabold text-gray-800 mb-1 mt-10 md:mt-0">
            {activeMenu}
          </div>

          {/* Page subtitle */}
          <div className="text-xs text-gray-400 mb-4">
            Current live sensor data and tank overview
          </div>

          {/* Active page component */}
          {renderPage()}
        </div>
      </div>
    </div>
  );
}

// ========================
// APP CONTENT COMPONENT
// ========================
/**
 * Conditional renderer: shows AuthPage for unauthenticated users,
 * DashboardLayout for authenticated users.
 */
function AppContent() {
  const { user } = useAuth();

  if (!user) {
    return <AuthPage />;
  }

  return <DashboardLayout />;
}

// ========================
// ROOT APP COMPONENT
// ========================
/**
 * The root component that wraps the entire application in context providers.
 * Provider nesting order matters: AuthProvider > SensorProvider > FloatingAlertProvider.
 * 
 * Provider responsibilities:
 *   - AuthProvider: Manages user authentication state
 *   - SensorProvider: Manages sensor data polling, settings, logs
 *   - FloatingAlertProvider: Manages toast notifications
 * 
 * Global components (outside page routing):
 *   - FloatingAlertContainer: Displays toast notifications
 *   - DeviceConnectionMonitor: Watches ESP32 connection status
 */
export default function App() {
  return (
    <AuthProvider>
      <SensorProvider>
        <FloatingAlertProvider>
          <AppContent />
          <FloatingAlertContainer />
          <DeviceConnectionMonitor />
        </FloatingAlertProvider>
      </SensorProvider>
    </AuthProvider>
  );
}
