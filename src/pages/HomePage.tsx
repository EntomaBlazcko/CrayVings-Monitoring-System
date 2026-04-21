import { Thermometer, Droplets, Waves, FlaskConical, AlertTriangle, AlertCircle, CheckCircle } from "lucide-react";
import type { SensorEntry } from "../types";
import { getAlerts } from "../utils/alerts";

type Props = {
  data: SensorEntry | null;
import { useEffect, useState } from "react";
import type { SensorEntry, MenuKey } from "../types";
import { getAlerts } from "../utils/alerts";
import { RefreshCw, BellOff, Settings } from "lucide-react";

type Props = {
  data: SensorEntry | null;
  onRefresh?: () => void;
  onNavigate?: (menu: MenuKey) => void;
};

type Stat = {
  title: string;
  value: string;
  description: string;
  gradient: string;
  icon: React.ReactNode;
};

function StatCard({ title, value, description, gradient, icon }: Stat) {
  return (
    <div className={`rounded-2xl bg-gradient-to-r ${gradient} p-5 text-white shadow-sm`}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/90">{title}</p>
        <div className="text-white/80">{icon}</div>
      </div>
      <h3 className="mt-2 text-3xl font-bold">{value}</h3>
      <p className="mt-2 text-sm text-white/90">{description}</p>
    </div>
  );
}

export default function HomePage({ data }: Props) {
  const hasData = !!data;
  const alerts = getAlerts(data);
  const safe = alerts.length === 1 && alerts[0] === "Tank is Safe";

  const getStatusBadge = () => {
    if (!hasData) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
          <AlertCircle size={14} />
          No Data
        </span>
      );
    }
    if (safe) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">
          <CheckCircle size={14} />
          Tank Safe
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
        <AlertTriangle size={14} />
        Attention Needed
      </span>
    );
  };

  const stats: Stat[] = [
    {
      title: "Water Temperature",
      value: data ? `${data.temperature}°C` : "--°C",
      description: "Current tank temperature",
      gradient: "from-blue-500 to-cyan-500",
      icon: <Thermometer size={24} />,
    },
    {
      title: "pH Level",
      value: data ? `${data.ph}` : "--",
      description: "Normal water acidity (6.5-8.5)",
      gradient: "from-emerald-400 to-teal-400",
      icon: <FlaskConical size={24} />,
    },
    {
      title: "Dissolved Oxygen",
      value: data ? `${data.dissolved_oxygen} mg/L` : "-- mg/L",
      description: "Healthy oxygen range",
      gradient: "from-sky-400 to-cyan-500",
      icon: <Droplets size={24} />,
    },
    {
      title: "Water Level",
      value: data ? `${data.water_level} cm` : "-- cm",
      description: "Tank water level",
      gradient: "from-indigo-500 to-blue-500",
      icon: <Waves size={24} />,
    },
  ];
export default function HomePage({ data, onRefresh, onNavigate }: Props) {
  const [stats, setStats] = useState<Stat[]>([]);
  const [alertsDismissed, setAlertsDismissed] = useState(false);
  const alerts = getAlerts(data);
  const isSafe = alerts.length === 1 && alerts[0] === "Tank is Safe";

  useEffect(() => {
    if (data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStats([
        {
          title: "Water Temperature",
          value: `${data.temperature ?? "--"}°C`,
          description: "Current tank temperature",
          gradient: "from-blue-500 to-cyan-500",
        },
        {
          title: "pH Level",
          value: `${data.ph ?? "--"}`,
          description: "Normal water acidity",
          gradient: "from-emerald-400 to-teal-400",
        },
        {
          title: "Dissolved Oxygen",
          value: `${data.dissolved_oxygen ?? "--"} mg/L`,
          description: "Healthy oxygen range",
          gradient: "from-sky-400 to-cyan-500",
        },
        {
          title: "Ammonia Level",
          value: `${data.ammonia ?? "--"} ppm`,
          description: "Safe water condition",
          gradient: "from-orange-400 to-red-400",
        },
      ]);
    }
  }, [data]);

  const highlights = [
    { label: "Temperature", value: data ? `${data.temperature}°C` : "--", color: "bg-blue-50 border-blue-200 text-blue-700" },
    { label: "Water Quality", value: data ? `${data.ph} pH` : "--", color: "bg-emerald-50 border-emerald-200 text-emerald-700" },
    { label: "Water Level", value: data ? `${data.water_level} cm` : "--", color: "bg-indigo-50 border-indigo-200 text-indigo-700" },
  ];

  const recentAlerts = alerts.slice(0, 4);

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl border border-gray-200 bg-gradient-to-r from-cyan-50 via-blue-50 to-orange-50 shadow-sm">
        <div
          className="absolute inset-0 bg-cover bg-center opacity-10"
          style={{ backgroundImage: "url('/craybitch without background.png')" }}
        />
        <div className="absolute inset-0 bg-white/20" />

        <div className="relative grid grid-cols-1 gap-6 p-6 lg:grid-cols-3 lg:p-8">
          <div className="flex flex-col justify-center lg:col-span-2">
            <div className="flex items-center gap-3 mb-3">
              <span className="inline-flex w-fit rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                Smart Aquaculture Dashboard
              </span>
              {getStatusBadge()}
            </div>
           

            <h1 className="text-3xl font-bold text-gray-900 lg:text-4xl">
              Welcome to CRAYvings Water Monitoring Home
            </h1>

            <p className="mt-4 max-w-2xl text-sm text-gray-600">
              Monitor key water quality parameters in real time to ensure a stable and optimal environment for crayfish production.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              {highlights.map((item) => (
                <div
                  key={item.label}
                  className={`rounded-xl border px-4 py-3 shadow-sm ${item.color}`}
                >
                  <p className="text-xs opacity-80">{item.label}</p>
                  <p className="text-sm font-semibold">{item.value}</p>
                </div>
              ))}
            </div>
          </div>

          <aside className="rounded-3xl border border-gray-200 bg-white/90 p-6 shadow-sm">
            <h3 className="mb-4 text-xl font-bold text-gray-800">System Alerts and Notifications</h3>
            {alertsDismissed ? (
              <p className="text-sm text-gray-400">Alerts dismissed</p>
            ) : (
              <div className="flex flex-col gap-2">
                {alerts.map((alert, index) => (
                  <div
                    key={index}
                    className={`rounded-lg p-3 font-bold text-sm ${
                      isSafe ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {alert}
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      </section>

      {!safe && hasData && (
        <section className="rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="text-red-600" size={18} />
            <h3 className="text-sm font-bold text-red-800">Recent Alerts</h3>
          </div>
          <div className="flex flex-col gap-2">
            {recentAlerts.map((alert, index) => (
              <div key={index} className="flex items-center gap-2 text-sm text-red-700">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                {alert}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <StatCard key={stat.title} {...stat} />
        ))}
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-1">
          <h3 className="mb-4 text-lg font-bold text-gray-800">Quick Controls</h3>
          <div className="flex flex-col gap-3">
            <button
              onClick={onRefresh}
              className="flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-600"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh Data
            </button>
            <button
              onClick={() => setAlertsDismissed(!alertsDismissed)}
              className="flex items-center gap-2 rounded-lg bg-gray-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-600"
            >
              <BellOff className="h-4 w-4" />
              {alertsDismissed ? "Show Alerts" : "Dismiss Alerts"}
            </button>
            <button
              onClick={() => onNavigate?.("Settings")}
              className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-600"
            >
              <Settings className="h-4 w-4" />
              Settings
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-3">
          <h3 className="mb-4 text-lg font-bold text-gray-800">Key Metrics Summary</h3>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-xl bg-blue-50 p-4">
              <p className="text-xs text-gray-500">Temperature</p>
              <p className="mt-1 text-2xl font-bold text-blue-600">{data?.temperature ?? "--"}°C</p>
              <p className="mt-1 text-xs text-gray-400">Optimal: 20-31°C</p>
            </div>
            <div className="rounded-xl bg-emerald-50 p-4">
              <p className="text-xs text-gray-500">pH Level</p>
              <p className="mt-1 text-2xl font-bold text-emerald-600">{data?.ph ?? "--"}</p>
              <p className="mt-1 text-xs text-gray-400">Optimal: 6.5-8.5</p>
            </div>
            <div className="rounded-xl bg-sky-50 p-4">
              <p className="text-xs text-gray-500">Dissolved Oxygen</p>
              <p className="mt-1 text-2xl font-bold text-sky-600">{data?.dissolved_oxygen ?? "--"} mg/L</p>
              <p className="mt-1 text-xs text-gray-400">Optimal: 5 mg/L</p>
            </div>
            <div className="rounded-xl bg-orange-50 p-4">
              <p className="text-xs text-gray-500">Ammonia</p>
              <p className="mt-1 text-2xl font-bold text-orange-600">{data?.ammonia ?? "--"} ppm</p>
              <p className="mt-1 text-xs text-gray-400">Safe: 0.5 ppm</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}