import { useEffect, useState } from "react";
import axios from "axios";
import type { MenuKey, SensorEntry, ChartPoint } from "./types";
import { API_BASE } from "./types";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import SensorsPage from "./pages/SensorsPage";
import AlertsPage from "./pages/AlertsPage";
import HistoricalDataPage from "./pages/HistoricalDataPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  const [data, setData] = useState<SensorEntry | null>(null);
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [error, setError] = useState("");
  const [activeMenu, setActiveMenu] = useState<MenuKey>("Dashboard");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const fetchSensorData = async () => {
      try {
        const [latestRes, historyRes] = await Promise.all([
          axios.get<SensorEntry>(`${API_BASE}/sensor/latest`),
          axios.get<SensorEntry[]>(`${API_BASE}/sensor`),
        ]);

        if (!mounted) return;

        setData(latestRes.data);
        setHistory(
          (historyRes.data || [])
            .slice()
            .reverse()
            .map((item) => ({
              name: item.timestamp
                ? new Date(item.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "--:--",
              temperature: item.temperature ?? 0,
              water_level: item.water_level ?? 0,
              ph: item.ph ?? 0,
              dissolved_oxygen: item.dissolved_oxygen ?? 0,
              ammonia: item.ammonia ?? 0,
            }))
        );

        setError("");
      } catch (err: unknown) {
        console.error("Fetch error:", err);

        const errorObj = err as { response?: { status?: number } };
        if (errorObj.response?.status === 404) {
          setData(null);
          setHistory([]);
          setError("No sensor data found in the database yet.");
        } else {
          setError("Failed to fetch sensor data. Check server, IP address, and network.");
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchSensorData();
    const interval = setInterval(fetchSensorData, 3000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const renderPage = () => {
    switch (activeMenu) {
      case "Home":
        return <HomePage />;
      case "Dashboard":
        return <DashboardPage data={data} history={history} />;
      case "Sensors":
        return <SensorsPage data={data} />;
      case "Alerts":
        return <AlertsPage data={data} />;
      case "Historical Data":
        return <HistoricalDataPage history={history} />;
      case "Settings":
        return <SettingsPage />;
      default:
        return <DashboardPage data={data} history={history} />;
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-100 font-sans">
      <Sidebar activeMenu={activeMenu} setActiveMenu={setActiveMenu} />

      <div className="flex-1 flex flex-col">
        <Header />

        <div className="p-5">
          <div className="text-2xl font-extrabold text-gray-800 mb-1">
            {activeMenu}
          </div>

          <div className="text-xs text-gray-400 mb-4">
            Current live sensor data and tank overview
          </div>

          {loading && (
            <div className="mb-3 bg-blue-50 border border-blue-200 text-blue-700 rounded-lg p-2.5 text-sm font-semibold">
              Loading sensor data...
            </div>
          )}

          {error && (
            <div className="mb-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-2.5 text-sm font-semibold">
              {error}
            </div>
          )}

          {renderPage()}
        </div>
      </div>
    </div>
  );
}
