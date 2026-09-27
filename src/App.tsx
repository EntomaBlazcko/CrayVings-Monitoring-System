import { useState, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import {
  Menu,
  X,
  LayoutDashboard,
  Activity,
  Bell,
  History,
  Settings,
  FileText,
  ClipboardList,
  BarChart3,
  Cpu,
} from "lucide-react";
import logo from "./assets/crayvings.png";
import type { MenuKey, UserRole } from "./types";
import { isValidMenuKey, VALID_MENU_KEYS } from "./types";
import Header from "./components/Header";
import AuthPage from "./pages/AuthPage";
import { LoadingCard } from "./components/Loading";
import { SensorProvider } from "./contexts/SensorProvider";
import { useActivityLogs } from "./hooks/useSensors";
import { AuthProvider } from "./contexts/AuthContext";
import { useAuth } from "./contexts/useAuth";
import { DeviceConnectionMonitor } from "./components/DeviceConnectionMonitor";
import { FloatingAlertProvider, FloatingAlertContainer } from "./components/FloatingAlert";
import { useThresholdAlert } from "./hooks/useThresholdAlert";
import CriticalAlarmBanner from "./components/CriticalAlarmBanner";
import { useFleetAlarms } from "./hooks/useFleetAlarms";

// Lazy-loaded pages so heavy deps (recharts, jspdf) download only on demand.
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const SensorsPage = lazy(() => import("./pages/SensorsPage"));
const AlertsPage = lazy(() => import("./pages/AlertsPage"));
const HistoricalDataPage = lazy(() => import("./pages/HistoricalDataPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const ActivityLogsPage = lazy(() => import("./pages/ActivityLogsPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
const DevicesPage = lazy(() => import("./pages/DevicesPage"));

const menuDefinitions: { label: MenuKey; icon: React.ReactNode }[] = [
  { label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { label: "Analytics", icon: <BarChart3 size={18} /> },
  { label: "Sensors", icon: <Activity size={18} /> },
  { label: "Alerts", icon: <Bell size={18} /> },
  { label: "Historical Data", icon: <History size={18} /> },
  { label: "Devices", icon: <Cpu size={18} /> },
  { label: "Activity Logs", icon: <ClipboardList size={18} /> },
  { label: "Sensor Logs", icon: <FileText size={18} /> },
  { label: "Settings", icon: <Settings size={18} /> },
];

// Admins see every page; users are restricted to monitoring pages. Enforced in
// the UI here and by requireAuth/requireAdmin on the server.
const ADMIN_MENU_KEYS: MenuKey[] = [...VALID_MENU_KEYS];

// "Devices" is deliberately absent: every write on that page (register, rename,
// hide, archive) is requireAdmin server-side, so exposing it to a plain 'user'
// would only show a page full of controls that all fail.
const USER_MENU_KEYS: MenuKey[] = [
  "Dashboard",
  "Analytics",
  "Sensors",
  "Alerts",
  "Historical Data",
  "Sensor Logs",
];

function getAllowedMenuKeys(role?: UserRole): MenuKey[] {
  return role === "admin" ? ADMIN_MENU_KEYS : USER_MENU_KEYS;
}

function getInitialMenuDefault(role?: UserRole): MenuKey {
  const saved = localStorage.getItem("activeMenu");
  if (saved && isValidMenuKey(saved) && getAllowedMenuKeys(role).includes(saved)) {
    return saved;
  }
  return "Dashboard";
}

function DashboardLayout() {
  const { user, logout } = useAuth();
  const { logActivity } = useActivityLogs();
  const previousMenuRef = useRef<MenuKey>("Dashboard");
  const activeMenuRef = useRef<MenuKey>(getInitialMenuDefault(user?.role));
  const [activeMenu, setActiveMenu] = useState<MenuKey>(getInitialMenuDefault(user?.role));
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useThresholdAlert();

  // Fleet-wide critical state drives both the persistent banner and the sidebar
  // count badge, so they can never disagree with each other.
  const { criticalCount, warningCount } = useFleetAlarms();

  const alarmBadgeFor = (menu: MenuKey) => {
    if (menu !== "Alerts") return null;
    if (criticalCount > 0) {
      return { text: String(criticalCount), cls: "bg-red-600 text-white", title: `${criticalCount} critical reading(s) need attention` };
    }
    if (warningCount > 0) {
      return { text: String(warningCount), cls: "bg-amber-400 text-amber-950", title: `${warningCount} reading(s) outside the safe range` };
    }
    return null;
  };

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
      case "Dashboard":
        page = <DashboardPage onNavigate={handleNavigate} />;
        break;
      case "Sensors":
        page = <SensorsPage />;
        break;
      case "Alerts":
        page = <AlertsPage onNavigate={handleNavigate} />;
        break;
      case "Historical Data":
        page = <HistoricalDataPage />;
        break;
      case "Devices":
        page = <DevicesPage />;
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
        page = <DashboardPage />;
        break;
    }

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
        className="fixed top-4 left-4 z-50 h-11 w-11 flex items-center justify-center bg-white rounded-lg shadow-lg md:hidden"
        aria-label={sidebarOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={sidebarOpen}
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
        className={`fixed md:static inset-y-0 left-0 z-50 w-24 bg-surface-sunken border-r border-surface-sunken-border min-h-screen flex flex-col items-center pt-4 transform transition-transform duration-300 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="w-14 h-14 rounded-full bg-white flex items-center justify-center overflow-hidden border-2 border-brand-200 mb-4">
          <img
            src={logo}
            alt="Logo"
            className="w-full h-full object-contain"
          />
        </div>

        <div className="w-full flex flex-col gap-1 px-2">
          {menuItems.map((item) => {
            const isActive = activeMenu === item.label;
            const badge = alarmBadgeFor(item.label);

            return (
              <button
                key={item.label}
                onClick={() => handleNavigate(item.label)}
                title={badge?.title}
                className={`relative flex flex-col items-center justify-center gap-1 py-3 px-1 rounded-lg text-micro font-semibold text-center cursor-pointer border-none w-full transition-colors ${
                  isActive
                    ? "bg-brand-100 text-brand-600 font-bold"
                    : "text-nav-muted hover:bg-surface-sunken-hover"
                }`}
              >
                {item.icon}
                <span className="leading-tight">{item.label}</span>
                {badge && (
                  <span
                    className={`absolute top-1 right-2 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold flex items-center justify-center ring-2 ring-surface-sunken ${badge.cls}`}
                  >
                    {badge.text}
                  </span>
                )}
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
          <CriticalAlarmBanner onGoToAlerts={() => handleNavigate("Alerts")} />

          <div className="text-xl md:text-2xl font-extrabold text-gray-800 mb-4 mt-10 md:mt-0">
            {activeMenu}
          </div>

          {renderPage()}
        </div>
      </div>
    </div>
  );
}

// SensorProvider mounts only after login so its authenticated polling and SSE
// connection never fire on the login screen.
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
