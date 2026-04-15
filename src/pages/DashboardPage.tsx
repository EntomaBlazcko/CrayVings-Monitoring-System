import {
  Thermometer,
  Waves,
  FlaskConical,
  Bell,
  Droplets,
  AlertTriangle,
} from "lucide-react";
import type { ChartPoint, SensorEntry } from "../types";
import StatCard from "../components/StatCard";
import TrendCard from "../components/TrendCard";
import { getAlerts } from "../utils/alerts";

type Props = {
  data: SensorEntry | null;
  history: ChartPoint[];
};

export default function DashboardPage({ data, history }: Props) {
  const alerts = getAlerts(data);
  const safe = alerts.length === 1 && alerts[0] === "Tank is Safe";

  return (
    <>
      <div className="grid grid-cols-5 gap-3 mb-4">
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
          value={`${data?.ph ?? 0}`}
          color="#6366f1"
          icon={<FlaskConical size={21} />}
        />
        <StatCard
          title="Ammonia"
          value={`${data?.ammonia ?? 0}`}
          color="#06b6d4"
          icon={<Bell size={21} />}
        />
        <StatCard
          title="Dissolved O₂"
          value={`${data?.dissolved_oxygen ?? 0}`}
          color="#10b981"
          icon={<Droplets size={21} />}
        />
      </div>

      <div className="grid grid-cols-[2fr_2fr_1.1fr] gap-3 items-stretch">
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

        <div className="flex flex-col gap-3">
          <div className="bg-white rounded-xl border border-gray-100 p-3.5 shadow-sm">
            <div className="text-xs font-bold text-gray-500 mb-2">Tank Alerts</div>
            <div
              className={`rounded-lg p-2 text-xs font-bold text-center ${
                safe ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
              }`}
            >
              {safe ? "Tank is Safe" : alerts[0]}
            </div>
          </div>

          <div className="bg-orange-50 rounded-xl border border-orange-200 p-3.5 shadow-sm">
            <div className="flex items-center gap-2 mb-2 text-orange-600 font-extrabold text-xs">
              <AlertTriangle size={16} />
              Current Reading
            </div>

            <div className="text-3xl font-extrabold text-red-500 mb-1.5">
              {data?.temperature ?? 0}°C
            </div>

            <div className="text-xs text-orange-800 leading-relaxed">
              Water temperature is currently being monitored in real time.
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 bg-white rounded-lg border border-gray-100 p-3 text-sm text-gray-600">
        <strong>Device:</strong> {data?.device_id ?? "N/A"} <br />
        <strong>Last Update:</strong>{" "}
        {data?.timestamp ? new Date(data.timestamp).toLocaleString() : "N/A"}
      </div>
    </>
  );
}
