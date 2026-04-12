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
  LayoutDashboard,
  Activity,
  Bell,
  History,
  Settings,
  Home,
  User,
  AlertTriangle,
} from "lucide-react";

type SensorEntry = {
  _id?: string;
  device_id: string;
  temperature: number;
  water_level: number;
  timestamp?: string;
};

type ChartPoint = {
  name: string;
  temperature: number;
  water_level: number;
};

type MenuKey =
  | "Home"
  | "Dashboard"
  | "Sensors"
  | "Alerts"
  | "Historical Data"
  | "Settings";

function StatCard({
  title,
  value,
  color,
  icon,
}: {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: 14,
        border: "1px solid #f1f1f1",
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        minHeight: 88,
        boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: "50%",
          background: `${color}18`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>

      <div>
        <div
          style={{
            fontSize: 12,
            color: "#7c7c7c",
            fontWeight: 600,
            marginBottom: 3,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: "#333",
            lineHeight: 1,
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function TrendCard({
  title,
  data,
  dataKey,
  stroke,
}: {
  title: string;
  data: ChartPoint[];
  dataKey: "temperature" | "water_level";
  stroke: string;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: 14,
        border: "1px solid #f1f1f1",
        padding: "14px 16px 10px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#666",
          marginBottom: 10,
          textAlign: "center",
        }}
      >
        {title}
      </div>

      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ececec" />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={stroke}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Sidebar({
  activeMenu,
  setActiveMenu,
}: {
  activeMenu: MenuKey;
  setActiveMenu: (menu: MenuKey) => void;
}) {
  const menu: { label: MenuKey; icon: React.ReactNode }[] = [
    { label: "Home", icon: <Home size={15} /> },
    { label: "Dashboard", icon: <LayoutDashboard size={15} /> },
    { label: "Sensors", icon: <Activity size={15} /> },
    { label: "Alerts", icon: <Bell size={15} /> },
    { label: "Historical Data", icon: <History size={15} /> },
    { label: "Settings", icon: <Settings size={15} /> },
  ];

  return (
    <div
      style={{
        width: 96,
        background: "#f5efe9",
        borderRight: "1px solid #eadfd6",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 14,
      }}
    >
      <div
        style={{
          width: 54,
          height: 54,
          borderRadius: "50%",
          background: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          border: "2px solid #e9d3c6",
          marginBottom: 14,
          fontSize: 10,
          fontWeight: 700,
          color: "#c2410c",
        }}
      >
        LOGO
      </div>

      <div
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "0 8px",
        }}
      >
        {menu.map((item) => {
          const isActive = activeMenu === item.label;

          return (
            <button
              key={item.label}
              onClick={() => setActiveMenu(item.label)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "10px 4px",
                borderRadius: 10,
                background: isActive ? "#ffe7d6" : "transparent",
                color: isActive ? "#c2410c" : "#9a6b57",
                fontSize: 10,
                fontWeight: isActive ? 700 : 600,
                textAlign: "center",
                cursor: "pointer",
                border: "none",
                width: "100%",
              }}
            >
              {item.icon}
              <span style={{ lineHeight: 1.1 }}>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HomePage() {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        border: "1px solid #f1f1f1",
        padding: 20,
      }}
    >
      <h2 style={{ margin: 0, color: "#333" }}>Home</h2>
      <p style={{ color: "#666" }}>
        Welcome to the CRAYvings Monitoring System.
      </p>
    </div>
  );
}

function SensorsPage({ data }: { data: SensorEntry | null }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        border: "1px solid #f1f1f1",
        padding: 20,
      }}
    >
      <h2 style={{ marginTop: 0, color: "#333" }}>Sensors</h2>
      <p><strong>Temperature:</strong> {data?.temperature ?? 0}°C</p>
      <p><strong>Water Level:</strong> {data?.water_level ?? 0} cm</p>
      <p><strong>Device ID:</strong> {data?.device_id ?? "N/A"}</p>
      <p>
        <strong>Last Update:</strong>{" "}
        {data?.timestamp ? new Date(data.timestamp).toLocaleString() : "N/A"}
      </p>
    </div>
  );
}

function AlertsPage({ data }: { data: SensorEntry | null }) {
  const safe = (data?.temperature ?? 0) < 31;

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        border: "1px solid #f1f1f1",
        padding: 20,
      }}
    >
      <h2 style={{ marginTop: 0, color: "#333" }}>Alerts</h2>
      <div
        style={{
          background: safe ? "#d1fae5" : "#fee2e2",
          color: safe ? "#047857" : "#b91c1c",
          borderRadius: 10,
          padding: 12,
          fontWeight: 700,
          display: "inline-block",
        }}
      >
        {safe ? "Tank is Safe" : "Warning: High Temperature"}
      </div>
    </div>
  );
}

function HistoricalDataPage({ history }: { history: ChartPoint[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      <TrendCard
        title="Temperature History"
        data={history}
        dataKey="temperature"
        stroke="#f97316"
      />
      <TrendCard
        title="Water Level History"
        data={history}
        dataKey="water_level"
        stroke="#2563eb"
      />
    </div>
  );
}

function SettingsPage() {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        border: "1px solid #f1f1f1",
        padding: 20,
      }}
    >
      <h2 style={{ marginTop: 0, color: "#333" }}>Settings</h2>
      <p style={{ color: "#666" }}>System settings panel.</p>
    </div>
  );
}

function DashboardPage({
  data,
  history,
}: {
  data: SensorEntry | null;
  history: ChartPoint[];
}) {
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <StatCard
          title="Temperature"
          value={`${data?.temperature ?? 0}°C`}
          color="#f97316"
          icon={<Thermometer size={21} />}
        />
        <StatCard
          title="Water Level"
          value={`${data?.water_level ?? 0} cm`}
          color="#2563eb"
          icon={<Waves size={21} />}
        />
        <StatCard
          title="pH Level"
          value="0"
          color="#6366f1"
          icon={<Activity size={21} />}
        />
        <StatCard
          title="Ammonia"
          value="0"
          color="#06b6d4"
          icon={<Bell size={21} />}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 2fr 1.1fr",
          gap: 12,
          alignItems: "stretch",
        }}
      >
        <TrendCard
          title="Water Temperature Over Time"
          data={history}
          dataKey="temperature"
          stroke="#f97316"
        />

        <TrendCard
          title="Water Level Trend"
          data={history}
          dataKey="water_level"
          stroke="#2563eb"
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: 14,
              border: "1px solid #f1f1f1",
              padding: 14,
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "#666",
                marginBottom: 8,
              }}
            >
              Tank Alerts
            </div>

            <div
              style={{
                background: "#d1fae5",
                color: "#047857",
                borderRadius: 10,
                padding: "8px 10px",
                fontSize: 12,
                fontWeight: 700,
                textAlign: "center",
              }}
            >
              Tank is Safe
            </div>
          </div>

          <div
            style={{
              background: "#fff7ed",
              borderRadius: 14,
              border: "1px solid #fed7aa",
              padding: 14,
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                color: "#ea580c",
                fontWeight: 800,
                fontSize: 12,
              }}
            >
              <AlertTriangle size={16} />
              Current Reading
            </div>

            <div
              style={{
                fontSize: 24,
                fontWeight: 800,
                color: "#ef4444",
                marginBottom: 6,
              }}
            >
              {data?.temperature ?? 0}°C
            </div>

            <div
              style={{
                fontSize: 12,
                color: "#9a3412",
                lineHeight: 1.4,
              }}
            >
              Water temperature is currently being monitored in real time.
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          background: "#fff",
          borderRadius: 12,
          border: "1px solid #f1f1f1",
          padding: "12px 14px",
          fontSize: 13,
          color: "#555",
        }}
      >
        <strong>Device:</strong> {data?.device_id ?? "N/A"} <br />
        <strong>Last Update:</strong>{" "}
        {data?.timestamp ? new Date(data.timestamp).toLocaleString() : "N/A"}
      </div>
    </>
  );
}

export default function App() {
  const [data, setData] = useState<SensorEntry | null>(null);
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [error, setError] = useState("");
  const [activeMenu, setActiveMenu] = useState<MenuKey>("Dashboard");

  useEffect(() => {
    const fetchLatest = async () => {
      try {
        const res = await axios.get<SensorEntry>(
          "http://192.168.1.20:3000/sensor/latest"
        );

        const latest = res.data;
        setData(latest);
        setError("");

        setHistory((prev) => {
          const newPoint = {
            name: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            temperature: latest.temperature,
            water_level: latest.water_level,
          };

          const updated = [...prev, newPoint];
          return updated.slice(-10);
        });
      } catch (err) {
        console.error(err);
        setError("Failed to fetch sensor data");
      }
    };

    fetchLatest();
    const interval = setInterval(fetchLatest, 3000);
    return () => clearInterval(interval);
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
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        background: "#f8f5f2",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <Sidebar activeMenu={activeMenu} setActiveMenu={setActiveMenu} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            height: 64,
            background: "linear-gradient(90deg, #d94b1e 0%, #ef6a2e 100%)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          <div>
            <div style={{ fontSize: 19, fontWeight: 800 }}>
              CRAYvings Monitoring System
            </div>
            <div style={{ fontSize: 11, opacity: 0.92 }}>
              Smart aquaculture monitoring dashboard
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            <User size={16} />
            Admin
          </div>
        </div>

        <div style={{ padding: 18 }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: "#333",
              marginBottom: 4,
            }}
          >
            {activeMenu}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "#8b8b8b",
              marginBottom: 14,
            }}
          >
            Current live sensor data and tank overview
          </div>

          {error && (
            <div
              style={{
                marginBottom: 12,
                background: "#fff1f2",
                border: "1px solid #fecdd3",
                color: "#be123c",
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {error}
            </div>
          )}

          {renderPage()}
        </div>
      </div>
    </div>
  );
}