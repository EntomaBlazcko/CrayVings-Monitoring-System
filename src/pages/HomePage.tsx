import { Thermometer, Droplets, Waves, FlaskConical, AlertTriangle, AlertCircle, CheckCircle } from "lucide-react";
import type { SensorEntry } from "../types";
import { getAlerts } from "../utils/alerts";

type Props = {
  data: SensorEntry | null;
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
          style={{ backgroundImage: "url('/crayfish-home.png')" }}
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
              Monitor Crayfish Water Conditions in Real Time
            </h1>

            <p className="mt-4 max-w-2xl text-sm text-gray-600">
              Track critical water quality parameters and maintain a stable environment for crayfish.
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

          <aside className="rounded-2xl border border-gray-200 bg-white/90 p-6 shadow-sm">
            <h3 className="mb-4 text-xl font-bold text-gray-800">About Crayfish</h3>
            <p className="text-sm text-gray-600">
              Crayfish require stable water quality. Monitoring temperature, pH,
              oxygen, and ammonia reduces stress and improves survival.
            </p>
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
            ))}git
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <StatCard key={stat.title} {...stat} />
        ))}
      </section>
    </div>
  );
}