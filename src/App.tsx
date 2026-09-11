// =============================================================================
// FILE: src/App.tsx
// PURPOSE: Root component with routing, layout, and context providers.
// =============================================================================

import { useState, useCallback, useRef, useMemo, lazy, Suspense } from "react";
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
  BarChart3,
} from "lucide-react";
import logo from "./assets/crayvings.png";
import type { MenuKey, UserRole } from "./types";
import { isValidMenuKey, VALID_MENU_KEYS } from "./types";
import Header from "./components/Header";
import AuthPage from "./pages/AuthPage";
import { LoadingCard } from "./components/Loading";
import { SensorProvider } from "./contexts/SensorProvider";
import { useActivityLogs } from "./contexts/SensorContext";
import { AuthProvider } from "./contexts/AuthContext";
import { useAuth } from "./contexts/useAuth";
import { DeviceConnectionMonitor } from "./components/DeviceConnectionMonitor";
import { FloatingAlertProvider, FloatingAlertContainer } from "./components/FloatingAlert";
import { useThresholdAlert } from "./hooks/useThresholdAlert";

// Lazy-loaded pages so heavy deps (recharts, jspdf) download only on demand.
const HomePage = lazy(() => import("./pages/HomePage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const SensorsPage = lazy(() => import("./pages/SensorsPage"));
const AlertsPage = lazy(() => import("./pages/AlertsPage"));
const HistoricalDataPage = lazy(() => import("./pages/HistoricalDataPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const ActivityLogsPage = lazy(() => import("./pages/ActivityLogsPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));

// ========================
// NAVIGATION MENU DEFINITION
// ========================
const menuDefinitions: { label: MenuKey; icon: React.ReactNode }[] = [
  { label: "Home", icon: <Home size={18} /> },
  { label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { label: "Sensors", icon: <Activity size={18} /> },
  { label: "Alerts", icon: <Bell size={18} /> },
  { label: "Historical Data", icon: <History size={18} /> },
  { label: "Analytics", icon: <BarChart3 size={18} /> },
  { label: "Activity Logs", icon: <ClipboardList size={18} /> },
  { label: "Sensor Logs", icon: <FileText size={18} /> },
  { label: "Settings", icon: <Settings size={18} /> },
];

// ========================
// ROLE-BASED ACCESS CONTROL
// ========================
// Admin sees every page; users are restricted to monitoring pages (no audit
// logs, settings, or user management). Enforced in the UI (menu + navigation)
// and on the server (requireAuth / requireAdmin).
const ADMIN_MENU_KEYS: MenuKey[] = [...VALID_MENU_KEYS];

const USER_MENU_KEYS: MenuKey[] = [
  "Home",
  "Dashboard",
  "Sensors",
  "Alerts",
  "Historical Data",
  "Analytics",
  "Sensor Logs",
];

function getAllowedMenuKeys(role?: UserRole): MenuKey[] {
  return role === "admin" ? ADMIN_MENU_KEYS : USER_MENU_KEYS;
}

// ========================
// LOCAL STORAGE STATE RESTORATION
// ========================
function getInitialMenuDefault(role?: UserRole): MenuKey {
  const saved = localStorage.getItem("activeMenu");
  if (saved && isValidMenuKey(saved) && getAllowedMenuKeys(role).includes(saved)) {
    return saved;
  }
  return "Home";
}

// ========================
// DASHBOARD LAYOUT COMPONENT
// ========================
function DashboardLayout() {
  const { user, logout } = useAuth();
  const { logActivity } = useActivityLogs();
  const previousMenuRef = useRef<MenuKey>("Home");
  const activeMenuRef = useRef<MenuKey>(getInitialMenuDefault(user?.role));
  const [activeMenu, setActiveMenu] = useState<MenuKey>(getInitialMenuDefault(user?.role));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  useThresholdAlert();

  const allowedKeys = useMemo(
    () => getAllowedMenuKeys(user?.role),
    [user?.role]
  );

  const menuItems = useMemo(
    () => menuDefinitions.filter((item) => allowedKeys.includes(item.label)),
    [allowedKeys]
  );

  const handleNavigate = useCallback((menu: MenuKey) => {
    if (!allowedKeys.includes(menu)) return; // role guard: ignore disallowed pages
    const prev = activeMenuRef.current;
    logActivity("navigation", `Navigated to ${menu}`, prev);
    previousMenuRef.current = prev;
    activeMenuRef.current = menu;
    setActiveMenu(menu);
    localStorage.setItem("activeMenu", menu);
    setSidebarOpen(false);
  }, [logActivity, allowedKeys]);

  const renderPage = useCallback(() => {
    let page: React.ReactNode;

    switch (activeMenu) {
      case "Home":
        page = <HomePage onNavigate={handleNavigate} />;
        break;
      case "Dashboard":
        page = <DashboardPage />;
        break;
      case "Sensors":
        page = <SensorsPage />;
        break;
      case "Alerts":
        page = <AlertsPage />;
        break;
      case "Historical Data":
        page = <HistoricalDataPage />;
        break;
      case "Analytics":
        page = <AnalyticsPage />;
        break;
      case "Activity Logs":
        page = <ActivityLogsPage />;
        break;
      case "Sensor Logs":
        page = <LogsPage />;
        break;
      case "Settings":
        page = <SettingsPage />;
        break;
      default:
        page = <HomePage onNavigate={handleNavigate} />;
        break;
    }

    // Suspense shows a loading state while lazy page chunks download.
    return (
      <Suspense
        fallback={
          <LoadingCard title={activeMenu} message="Loading page..." />
        }
      >
        {page}
      </Suspense>
    );
  }, [activeMenu, handleNavigate]);

  if (!user) return null;

  return (
    <div className="flex min-h-screen bg-gray-100 font-sans">
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed top-4 left-4 z-50 p-2 bg-white rounded-lg shadow-lg md:hidden"
      >
        {sidebarOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`fixed md:static inset-y-0 left-0 z-50 w-24 bg-[#f5efe9] border-r border-[#eadfd6] min-h-screen flex flex-col items-center pt-4 transform transition-transform duration-300 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
        >
        <div className="w-14 h-14 rounded-full bg-white flex items-center justify-center overflow-hidden border-2 border-[#e9d3c6] mb-4">
          <img
            src={logo}
            alt="Logo"
            className="w-full h-full object-contain"
          />
        </div>

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

      <div className="flex-1 flex flex-col w-full md:w-auto">
        <Header user={user} onLogout={() => {
          logActivity("logout", `${user.name} logged out`, "Auth");
          logout();
        }} />

        <div className="p-3 md:p-5">
          <div className="text-xl md:text-2xl font-extrabold text-gray-800 mb-1 mt-10 md:mt-0">
            {activeMenu}
          </div>

          <div className="text-xs text-gray-400 mb-4">
            Current live sensor data and tank overview
          </div>

          {renderPage()}
        </div>
      </div>
    </div>
  );
}

// ========================
// APP CONTENT COMPONENT
// ========================
// SensorProvider only mounts after login so background polling (which now
// requires auth) never fires on the AuthPage.
function AppContent() {
  const { user } = useAuth();

  if (!user) {
    return <AuthPage />;
  }

  return (
    <SensorProvider>
      <DeviceConnectionMonitor />
      <DashboardLayout />
    </SensorProvider>
  );
}

// ========================
// ROOT APP COMPONENT
// ========================
export default function App() {
  return (
    <AuthProvider>
      <FloatingAlertProvider>
        <AppContent />
        <FloatingAlertContainer />
      </FloatingAlertProvider>
    </AuthProvider>
  );
}
