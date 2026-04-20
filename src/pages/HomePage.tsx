import { useEffect, useState } from "react";

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

export default function HomePage() {
  const [stats, setStats] = useState<Stat[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("http://localhost:3000/sensor/latest")
      .then((res) => res.json())
      .then((data) => {
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
      })
      .catch(() => setError(true));
  }, []);

  const highlights = [
    { label: "Temperature", value: "Live Monitoring" },
    { label: "Water Quality", value: "pH, DO, Ammonia" },
    { label: "Water Level", value: "Tank Overview" },
  ];

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          Failed to fetch sensor data
        </div>
      )}

      <section className="relative overflow-hidden rounded-3xl border border-gray-200 bg-gradient-to-r from-cyan-50 via-blue-50 to-orange-50 shadow-sm">
        <div
          className="absolute inset-0 bg-cover bg-center opacity-10"
          style={{ backgroundImage: "url('/crayfish-home.png')" }}
        />
        <div className="absolute inset-0 bg-white/20" />

        <div className="relative grid grid-cols-1 gap-6 p-6 lg:grid-cols-3 lg:p-8">
          <div className="flex flex-col justify-center lg:col-span-2">
            <span className="mb-3 inline-flex w-fit rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
              Smart Aquaculture Dashboard
            </span>

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
                  className="rounded-xl border border-gray-200 bg-white/80 px-4 py-3 shadow-sm"
                >
                  <p className="text-xs text-gray-500">{item.label}</p>
                  <p className="text-sm font-semibold text-gray-800">{item.value}</p>
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

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <StatCard key={stat.title} {...stat} />
        ))}
      </section>
    </div>
  );
}