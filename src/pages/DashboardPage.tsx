import { useMemo } from "react";
import { Thermometer, Waves, FlaskConical, Droplets, AlertTriangle } from "lucide-react";
import StatCard from "../components/StatCard";
import TrendCard from "../components/TrendCard";
import { useSensors } from "../hooks/useSensors";
import { getSettingsThresholds, getThresholdStatus } from "../types";

export default function DashboardPage() {
  const { data, history, connectionStatus, lastUpdate, settings } = useSensors();
  
  const thresholds = useMemo(() => getSettingsThresholds(settings), [settings]);
  
  const isOnline = connectionStatus === "online";
  
  const tankStatus = useMemo(() => {
    if (!data) return { safe: true, messages: ["No sensor data"] };
    
    const messages: string[] = [];
    const sensorKeys = ["temperature", "ph", "dissolved_oxygen", "ammonia", "water_level"] as const;
    
    for (const key of sensorKeys) {
      const threshold = thresholds[key];
      const value = data[key];
      const status = getThresholdStatus(value, threshold.range, threshold.isMinOnly);
      
      if (status === "warning") {
        const direction = value < threshold.range.min ? "below" : "above";
        messages.push(`${threshold.name} ${direction} threshold`);
      }
    }
    
    return {
      safe: messages.length === 0,
      messages: messages.length > 0 ? messages : ["All parameters within safe range"],
    };
  }, [data, thresholds]);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 md:gap-3 mb-4">
        <StatCard
          title="Temperature"
          value={`${data?.temperature ?? 0}°C`}
          color="#f97316"
          icon={<Thermometer size={18} />}
        />
        <StatCard
          title="Water Level"
          value={`${data?.water_level ?? 0}`}
          color="#2563eb"
          icon={<Waves size={18} />}
        />
        <StatCard
          title="pH Level"
          value={`${data?.ph ?? 0}`}
          color="#6366f1"
          icon={<FlaskConical size={18} />}
        />
        <StatCard
          title="Ammonia"
          value={`${data?.ammonia ?? 0}`}
          color="#06b6d4"
          icon={<AlertTriangle size={18} />}
        />
        <StatCard
          title="Dissolved O₂"
          value={`${data?.dissolved_oxygen ?? 0}`}
          color="#10b981"
          icon={<Droplets size={18} />}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <TrendCard
          title="Temperature"
          data={history}
          dataKey="temperature"
          stroke="#f97316"
        />
        <TrendCard
          title="Water Level"
          data={history}
          dataKey="water_level"
          stroke="#2563eb"
        />
        <TrendCard
          title="pH Level"
          data={history}
          dataKey="ph"
          stroke="#6366f1"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm md:col-span-3">
          <div className="text-xs font-bold text-gray-500 mb-2">
            Sensor Hub Status
          </div>
          <div className="text-sm font-semibold mb-2">
            ESP32 Module
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${isOnline ? "bg-green-500" : "bg-red-500"}`}
            />
            <span className={`text-xs font-bold ${isOnline ? "text-green-600" : "text-red-600"}`}>
              {isOnline ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-4">
            Updated: {lastUpdate ? lastUpdate.toLocaleTimeString() : "N/A"}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm overflow-auto md:col-span-6">
          <div className="text-xs font-bold text-gray-500 mb-3">
            Recent Readings
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[200px]">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left py-1">Time</th>
                  <th className="text-center py-1">Temp</th>
                  <th className="text-center py-1">Level</th>
                  <th className="text-center py-1">pH</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(-5).reverse().map((h, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1">{h.name}</td>
                    <td className="text-center py-1">{h.temperature}°C</td>
                    <td className="text-center py-1">{h.water_level}</td>
                    <td className="text-center py-1">{h.ph}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-col gap-3 md:col-span-3">
          <div className="bg-white rounded-xl border border-gray-100 p-3 shadow-sm">
            <div className="text-xs font-bold text-gray-500 mb-2">
              Tank Status
            </div>
            <div className={`rounded-lg p-2 text-xs font-bold text-center ${
              tankStatus.safe 
                ? "bg-emerald-100 text-emerald-700" 
                : "bg-red-100 text-red-700"
            }`}>
              {tankStatus.safe ? "Tank is Safe" : "Alert: Check parameters"}
            </div>
          </div>

          <div className="bg-orange-50 rounded-xl border border-orange-200 p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-2 text-orange-600 font-bold text-xs">
              <AlertTriangle size={14} />
              Temperature
            </div>
            <div className="text-2xl md:text-3xl font-extrabold text-red-500">
              {data?.temperature ?? 0}°C
            </div>
            <div className="text-xs text-orange-800 mt-1">
              Real-time monitoring
            </div>
          </div>
        </div>
      </div>
    </>
  );
}