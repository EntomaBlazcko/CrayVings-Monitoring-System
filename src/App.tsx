import "./App.css";
import { useEffect, useState } from "react";
import axios from "axios";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Thermometer,
  Waves,
  FlaskConical,
  AlertTriangle,
  LayoutDashboard,
  Cpu,
  Bell,
  History,
  Settings,
  Activity,
} from "lucide-react";

type SensorEntry = {
  _id?: string;
  device_id: string;
  temperature: number;
  water_level: number;
  timestamp?: string;
};

type StatCardProps = {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
};

function StatCard({ title, value, color, icon }: StatCardProps) {
  return (
    <div style={{
      background: "#fff",
      borderRadius: 18,
      padding: "18px 20px",
      display: "flex",
      alignItems: "center",
      gap: 14,
      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
      border: "1px solid #e5e7eb",
    }}>
      <div style={{
        width: 48,
        height: 48,
        borderRadius: "50%",
        background: `${color}20`,
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        {icon}
      </div>

      <div>
        <div style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>
          {title}
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, color }}>{value}</div>
      </div>
    </div>
  );
}

function Sidebar() {
  const menu = [
    { label: "Dashboard", icon: <LayoutDashboard size={18} /> },
    { label: "Sensors", icon: <Activity size={18} /> },
    { label: "Alerts", icon: <Bell size={18} /> },
    { label: "Historical Data", icon: <History size={18} /> },
    { label: "Settings", icon: <Settings size={18} /> },
  ];

  return (
    <div style={{
      width: 230,
      background: "#c2410c",
      color: "#fff",
      minHeight: "100vh",
      padding: 18,
    }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>CRAYvings</div>

      <div style={{ marginTop: 20, display: "grid", gap: 10 }}>
        {menu.map((item, index) => (
          <button
            key={item.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 12,
              border: "none",
              background: index === 0 ? "#fff" : "transparent",
              color: index === 0 ? "#c2410c" : "#fff",
              fontWeight: 600,
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<SensorEntry[]>([]);
function App() {
  const [data, setData] = useState<SensorEntry | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const fetchLatestData = async () => {
      try {
        const res = await axios.get<SensorEntry | null>(
          "http://192.168.1.20:3000/sensor/latest"
        );

        console.log("Fetched latest sensor data:", res.data);

        setData(res.data);
        setError("");
      } catch (err) {
        console.error(err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
        console.error("Error fetching latest sensor data:", err);
        setError("Failed to fetch sensor data.");
      } finally {
        setLoading(false);
      }
    };

    fetchLatestData();

    const interval = setInterval(() => {
      fetchLatestData();
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  const latest = data[0];

  const temperatureData = data.map((d, i) => ({
    name: `#${i + 1}`,
    value: d.temperature,
  }));

  const waterLevelData = data.map((d, i) => ({
    name: `#${i + 1}`,
    value: d.water_level,
  }));

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#f3f4f6" }}>
      <Sidebar />

      <div style={{ flex: 1 }}>
        <div style={{
          background: "#c2410c",
          color: "#fff",
          padding: "20px 24px",
          fontSize: 28,
          fontWeight: 700,
        }}>
          CRAYvings Water Monitoring System
        </div>

        <div style={{ padding: 24 }}>
          {/* LIVE STAT CARDS */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
            marginBottom: 24,
          }}>
            <StatCard
              title="Temperature"
              value={`${latest?.temperature ?? 0} °C`}
              color="#f97316"
              icon={<Thermometer size={24} />}
            />
            <StatCard
              title="Water Level"
              value={`${latest?.water_level ?? 0} %`}
              color="#0ea5e9"
              icon={<Waves size={24} />}
            />
          </div>

          {/* LIVE CHARTS */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
            gap: 20,
          }}>
            <div style={{
              background: "#fff",
              borderRadius: 22,
              padding: 20,
            }}>
              <h3>Temperature Trend</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={temperatureData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Line dataKey="value" stroke="#f97316" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{
              background: "#fff",
              borderRadius: 22,
              padding: 20,
            }}>
              <h3>Water Level Trend</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={waterLevelData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Line dataKey="value" stroke="#0ea5e9" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* RAW DEVICE DATA */}
          <div style={{ marginTop: 24 }}>
            {data.map((d, i) => (
              <div key={i} style={{
                background: "#fff",
                padding: 16,
                marginBottom: 10,
                borderRadius: 12,
              }}>
                Device: {d.device_id} | Temp: {d.temperature}°C | Level: {d.water_level}%
              </div>
            ))}
          </div>
        </div>
      </div>
    <div className="p-10 min-h-screen bg-gray-100">
      <h1 className="text-3xl font-bold mb-6 text-center">
        Aquaculture Monitoring Dashboard
      </h1>

      {loading ? (
        <p className="text-center text-lg">Loading latest sensor data...</p>
      ) : error ? (
        <p className="text-center text-red-500">{error}</p>
      ) : data ? (
        <div className="max-w-xl mx-auto bg-white p-8 rounded-xl shadow-md">
          <h2 className="text-2xl font-semibold mb-4 text-center">
            Device: {data.device_id}
          </h2>

          <p className="text-2xl mb-3">
            Temperature: {data.temperature} °C
          </p>

          <p className="text-2xl mb-3">
            Water Level: {data.water_level} %
          </p>

          <p className="text-sm text-gray-500 mt-6 text-center">
            Last Updated:{" "}
            {data.timestamp
              ? new Date(data.timestamp).toLocaleString()
              : "No timestamp"}
          </p>
        </div>
      ) : (
        <p className="text-center text-red-500">No sensor data found.</p>
      )}
    </div>
  );
}