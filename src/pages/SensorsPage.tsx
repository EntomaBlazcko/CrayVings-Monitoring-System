import { useMemo } from "react";
import { 
  Thermometer, 
  Waves, 
  FlaskConical, 
  Droplets,
  AlertTriangle,
  Radio,
  Activity,
  CheckCircle,
  XCircle,
  Clock,
} from "lucide-react";
import { useSensors } from "../hooks/useSensors";
import { getSettingsThresholds, getThresholdStatus } from "../types";

function formatTimeAgo(timestamp: string): string {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return "Invalid date";
  
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SensorsPage() {
  const { data, connectionStatus, settings, settingsLoading, settingsError } = useSensors();
  
  const thresholds = useMemo(() => getSettingsThresholds(settings), [settings]);
  
  const isOnline = useMemo(() => {
    if (connectionStatus === "online") return true;
    if (!data?.timestamp) return false;
    const dataTime = new Date(data.timestamp).getTime();
    return !isNaN(dataTime) && Date.now() - dataTime < 10000;
  }, [data?.timestamp, connectionStatus]);

  const sensors = useMemo(() => {
    const sensorKeys = ["temperature", "ph", "dissolved_oxygen", "water_level", "ammonia"] as const;
    
    const icons: Record<string, React.ReactNode> = {
      temperature: <Thermometer size={20} />,
      ph: <FlaskConical size={20} />,
      dissolved_oxygen: <Droplets size={20} />,
      water_level: <Waves size={20} />,
      ammonia: <AlertTriangle size={20} />,
    };
    
    const colors: Record<string, { color: string; bg: string; border: string }> = {
      temperature: { color: "text-orange-500", bg: "bg-orange-50", border: "border-orange-200" },
      ph: { color: "text-purple-500", bg: "bg-purple-50", border: "border-purple-200" },
      dissolved_oxygen: { color: "text-sky-500", bg: "bg-sky-50", border: "border-sky-200" },
      water_level: { color: "text-blue-500", bg: "bg-blue-50", border: "border-blue-200" },
      ammonia: { color: "text-amber-500", bg: "bg-amber-50", border: "border-amber-200" },
    };
    
    return sensorKeys.map((key) => {
      const threshold = thresholds[key];
      const value = data?.[key] ?? null;
      const status = value !== null 
        ? getThresholdStatus(value, threshold.range, threshold.isMinOnly)
        : "warning";
      const isWarning = status !== "good";
      const colorScheme = colors[key];
      
      return {
        name: threshold.name,
        value,
        unit: threshold.unit,
        threshold,
        status,
        isWarning,
        icon: icons[key],
        ...colorScheme,
      };
    });
  }, [data, thresholds]);

  if (settingsLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <Activity size={40} className="mx-auto mb-3 text-gray-400" />
        <h2 className="mt-0 text-gray-800">Sensors</h2>
        <p className="text-gray-600">Loading settings...</p>
      </div>
    );
  }

  if (settingsError || !data) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <Activity size={40} className="mx-auto mb-3 text-gray-400" />
        <h2 className="mt-0 text-gray-800">Sensors</h2>
        <p className="text-gray-600">No sensor data available yet.</p>
        <p className="text-sm text-gray-500 mt-2">
          Waiting for ESP32 to send data...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="mt-0 text-gray-800 flex items-center gap-2">
              <Activity size={20} className="text-gray-600" />
              Sensor Status
            </h2>
            <p className="text-gray-600 text-sm mt-1">
              Real-time sensor readings and connection status
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Radio size={18} className={isOnline ? "text-green-500" : "text-red-500"} />
            <span className={`font-semibold text-sm ${isOnline ? "text-green-600" : "text-red-600"}`}>
              {isOnline ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        {sensors.map((sensor) => (
          <div
            key={sensor.name}
            className={`rounded-xl border ${sensor.border} ${sensor.bg} p-3 md:p-4`}
          >
            <div className="flex items-center justify-between mb-2 md:mb-3">
              <div className={sensor.color}>
                {sensor.icon}
              </div>
              {sensor.isWarning ? (
                <XCircle size={16} className="text-red-500" />
              ) : (
                <CheckCircle size={16} className="text-green-500" />
              )}
            </div>
            
            <div className="text-xs font-semibold text-gray-500 uppercase mb-1">
              {sensor.name}
            </div>
            
            <div className="text-xl md:text-2xl font-bold text-gray-800">
              {sensor.value ?? "--"}{sensor.unit}
            </div>

            <div className="mt-2 pt-2 border-t border-gray-200/50 text-xs text-gray-600">
              <span className="font-medium">Threshold:</span>{" "}
              {sensor.threshold.isMinOnly 
                ? `> ${sensor.threshold.range.min}${sensor.unit}`
                : `${sensor.threshold.range.min} - ${sensor.threshold.range.max}${sensor.unit}`
              }
            </div>

            {sensor.isWarning && sensor.value !== null && (
              <div className="mt-2 text-xs font-semibold text-red-600">
                {sensor.value < sensor.threshold.range.min ? "Below" : "Above"} threshold!
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs font-bold text-gray-500 uppercase mb-3 flex items-center gap-2">
            Connection Info
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Device ID</span>
              <span className="font-medium">{data.device_id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Status</span>
              <span className={`font-medium ${isOnline ? "text-green-600" : "text-red-600"}`}>
                {isOnline ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs font-bold text-gray-500 uppercase mb-3 flex items-center gap-2">
            <Clock size={16} />
            Last Update
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Timestamp</span>
              <span className="font-medium">
                {data.timestamp ? new Date(data.timestamp).toLocaleString() : "N/A"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Time Ago</span>
              <span className="font-medium">
                {data.timestamp ? formatTimeAgo(data.timestamp) : "N/A"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}