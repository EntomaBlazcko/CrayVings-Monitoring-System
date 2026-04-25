import { useState, useMemo } from "react";
import { 
  History, 
  Thermometer, 
  Waves, 
  FlaskConical,
  Droplets,
  Filter,
} from "lucide-react";
import TrendCard from "../components/TrendCard";
import { useSensors } from "../hooks/useSensors";

type TimeRange = "1h" | "6h" | "24h" | "all";

export default function HistoricalDataPage() {
  const { history, loading, error } = useSensors();
  const [timeRange, setTimeRange] = useState<TimeRange>("all");

  const timeRanges: { value: TimeRange; label: string }[] = [
    { value: "1h", label: "1 Hour" },
    { value: "6h", label: "6 Hours" },
    { value: "24h", label: "24 Hours" },
    { value: "all", label: "All Time" },
  ];

  const filteredHistory = useMemo(() => {
    if (timeRange === "all" || history.length === 0) {
      return history;
    }
    
    const now = Date.now();
    const hours = timeRange === "1h" ? 1 : timeRange === "6h" ? 6 : 24;
    const cutoff = now - hours * 60 * 60 * 1000;
    
    return history.filter((item) => {
      const timestamp = new Date(item.name).getTime();
      return timestamp > cutoff || item.name === "--:--";
    });
  }, [history, timeRange]);

  const chartData = useMemo(
    () => filteredHistory.slice(0, 50),
    [filteredHistory]
  );

  const latestReading = chartData[chartData.length - 1];

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <History size={40} className="mx-auto mb-3 text-gray-400" />
        <p className="text-gray-600">Loading historical data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <History size={40} className="mx-auto mb-3 text-red-400" />
        <p className="text-gray-600">Failed to load historical data</p>
        <p className="text-sm text-gray-500 mt-2">{error}</p>
      </div>
    );
  }

  if (!history.length) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <History size={40} className="mx-auto mb-3 text-gray-400" />
        <h2 className="mt-0 text-gray-800">Historical Data</h2>
        <p className="text-gray-600">No historical data available yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="mt-0 text-gray-800 flex items-center gap-2">
              <History size={20} className="text-blue-500" />
              Historical Data
            </h2>
            <p className="text-gray-600 text-sm mt-1">
              View sensor data trends over time
            </p>
          </div>
          <div className="text-sm text-gray-500">
            {chartData.length} readings
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Filter size={16} className="text-gray-500" />
        {timeRanges.map((range) => (
          <button
            key={range.value}
            onClick={() => setTimeRange(range.value)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              timeRange === range.value
                ? "bg-blue-500 text-white"
                : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {range.label}
          </button>
        ))}
      </div>

      {chartData.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="flex items-center gap-2 text-gray-500 mb-1">
              <Thermometer size={14} />
              <span className="text-xs font-medium">Temperature</span>
            </div>
            <div className="text-xl font-bold text-gray-800">
              {latestReading?.temperature ?? "--"}°C
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="flex items-center gap-2 text-gray-500 mb-1">
              <FlaskConical size={14} />
              <span className="text-xs font-medium">pH Level</span>
            </div>
            <div className="text-xl font-bold text-gray-800">
              {latestReading?.ph ?? "--"}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="flex items-center gap-2 text-gray-500 mb-1">
              <Waves size={14} />
              <span className="text-xs font-medium">Water Level</span>
            </div>
            <div className="text-xl font-bold text-gray-800">
              {latestReading?.water_level ?? "--"}%
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="flex items-center gap-2 text-gray-500 mb-1">
              <Droplets size={14} />
              <span className="text-xs font-medium">Dissolved O₂</span>
            </div>
            <div className="text-xl font-bold text-gray-800">
              {latestReading?.dissolved_oxygen ?? "--"} mg/L
            </div>
          </div>
        </div>
      )}

      {chartData.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          <TrendCard
            title="Temperature"
            data={chartData}
            dataKey="temperature"
            stroke="#f97316"
          />
          <TrendCard
            title="Water Level"
            data={chartData}
            dataKey="water_level"
            stroke="#2563eb"
          />
          <TrendCard
            title="pH Level"
            data={chartData}
            dataKey="ph"
            stroke="#6366f1"
          />
          <TrendCard
            title="Dissolved Oxygen"
            data={chartData}
            dataKey="dissolved_oxygen"
            stroke="#0ea5e9"
          />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <History size={40} className="mx-auto mb-3 text-gray-400" />
          <p className="text-gray-600">No data for selected time range.</p>
        </div>
      )}
    </div>
  );
}