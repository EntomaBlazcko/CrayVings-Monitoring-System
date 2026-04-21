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
};

function StatCard({ title, value, description, gradient }: Stat) {
  return (
    <div className={`rounded-2xl bg-gradient-to-r ${gradient} p-5 text-white shadow-sm`}>
      <p className="text-sm text-white/90">{title}</p>
      <h3 className="mt-2 text-3xl font-bold">{value}</h3>
      <p className="mt-2 text-sm text-white/90">{description}</p>
    </div>
  );
}

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
    { label: "Temperature", value: "Live Monitoring" },
    { label: "Water Quality", value: "pH, DO, Ammonia" },
    { label: "Water Level", value: "Tank Overview" },
  ];

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
                  className="rounded-xl border border-gray-200 bg-white/80 px-4 py-3 shadow-sm"
                >
                  <p className="text-xs text-gray-500">{item.label}</p>
                  <p className="text-sm font-semibold text-gray-800">{item.value}</p>
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