import { useState, useCallback, useRef } from "react";
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
import logo from "./assets/craybitch without background.png";
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
import { SensorProvider } from "./contexts/SensorProvider";
import { useActivityLogs } from "./contexts/SensorContext";
import { FloatingAlertProvider, FloatingAlertContainer } from "./components/FloatingAlert";
import { useThresholdAlert } from "./hooks/useThresholdAlert";

const menuItems: { label: MenuKey; icon: React.ReactNode }[] = [
  { label: "Home", icon: <Home size={18} /> },
  { label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { label: "Sensors", icon: <Activity size={18} /> },
  { label: "Alerts", icon: <Bell size={18} /> },
  { label: "Historical Data", icon: <History size={18} /> },
  { label: "Activity Logs", icon: <ClipboardList size={18} /> },
  { label: "Settings", icon: <Settings size={18} /> },
  { label: "Logs", icon: <FileText size={18} /> },
];

function AppContent() {
  const { logActivity } = useActivityLogs();
  const previousMenuRef = useRef<MenuKey>("Home");
  useThresholdAlert();

  const getInitialMenu = useCallback((): MenuKey => {
    const saved = localStorage.getItem("activeMenu");
    if (saved && isValidMenuKey(saved)) {
      return saved;
    }
    return "Home";
  }, []);

  const [activeMenu, setActiveMenu] = useState<MenuKey>(getInitialMenu);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleNavigate = useCallback((menu: MenuKey) => {
    logActivity("navigation", `Navigated to ${menu}`, previousMenuRef.current);
    previousMenuRef.current = activeMenu;
    setActiveMenu(menu);
    localStorage.setItem("activeMenu", menu);
    setSidebarOpen(false);
  }, [logActivity, activeMenu]);

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
      case "Logs":
        return <LogsPage />;
      case "Settings":
        return <SettingsPage />;
      default:
        return <HomePage onNavigate={handleNavigate} />;
    }
  }, [activeMenu, handleNavigate]);

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
        <Header />

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

export default function App() {
  return (
    <SensorProvider>
      <FloatingAlertProvider>
        <AppContent />
        <FloatingAlertContainer />
      </FloatingAlertProvider>
    </SensorProvider>
  );
}