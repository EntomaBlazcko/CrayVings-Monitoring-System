import { useEffect, useState, useMemo } from "react";
import axios from "axios";
import { 
  Thermometer, 
  Waves, 
  FlaskConical, 
  Droplets, 
  AlertTriangle,
  Radio,
  Wifi,
  Clock,
  Activity,
  CheckCircle,
  XCircle
} from "lucide-react";
import type { SensorEntry, SensorSettings } from "../types";
import { SETTINGS_ENDPOINT } from "../types";

type Props = {
  data: SensorEntry | null;
};

function TimeAgo({ timestamp }: { timestamp: string }) {
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    if (!timestamp) return;
    
    const update = () => {
      setSecondsAgo(Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
    };
    
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [timestamp]);

  return <span>{secondsAgo}s ago</span>;
}

export default function SensorsPage({ data }: Props) {
  const [settings, setSettings] = useState<SensorSettings | null>(null);

  const fetchSettings = async () => {
    try {
      const res = await axios.get<SensorSettings>(SETTINGS_ENDPOINT);
      setSettings(res.data);
    } catch (err) {
      console.error("Fetch settings error:", err);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const isOnline = useMemo(() => {
    if (!data?.timestamp) return false;
    // eslint-disable-next-line react-hooks/purity
    return Date.now() - new Date(data.timestamp).getTime() < 10000;
  }, [data?.timestamp]);

  const getSensorStatus = (current: number, min: number, max: number, isMinOnly = false) => {
    if (isMinOnly) {
      return current >= min ? "good" : "warning";
    }
    if (current < min || current > max) return "warning";
    return "good";
  };

  const sensors = [
    { 
      name: "Temperature", 
      value: data?.temperature, 
      unit: "°C",
      min: settings?.temp_min ?? 20, 
      max: settings?.temp_max ?? 31,
      isMinOnly: false,
      icon: <Thermometer size={20} />,
      color: "text-orange-500",
      bg: "bg-orange-50",
      border: "border-orange-200"
    },
    { 
      name: "pH Level", 
      value: data?.ph, 
      unit: "",
      min: settings?.ph_min ?? 6.5, 
      max: settings?.ph_max ?? 8.5,
      isMinOnly: false,
      icon: <FlaskConical size={20} />,
      color: "text-purple-500",
      bg: "bg-purple-50",
      border: "border-purple-200"
    },
    { 
      name: "Dissolved Oxygen", 
      value: data?.dissolved_oxygen, 
      unit: "mg/L",
      min: settings?.do_min ?? 5, 
      max: settings?.do_max ?? 10,
      isMinOnly: false,
      icon: <Droplets size={20} />,
      color: "text-sky-500",
      bg: "bg-sky-50",
      border: "border-sky-200"
    },
    { 
      name: "Water Level", 
      value: data?.water_level, 
      unit: "%",
      min: settings?.water_level_min ?? 10, 
      max: settings?.water_level_max ?? 100,
      isMinOnly: false,
      icon: <Waves size={20} />,
      color: "text-blue-500",
      bg: "bg-blue-50",
      border: "border-blue-200"
    },
    { 
      name: "Ammonia", 
      value: data?.ammonia, 
      unit: "ppm",
      min: settings?.ammonia_min ?? 0, 
      max: settings?.ammonia_max ?? 0.5,
      isMinOnly: false,
      icon: <AlertTriangle size={20} />,
      color: "text-amber-500",
      bg: "bg-amber-50",
      border: "border-amber-200"
    },
  ];

  if (!data) {
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
      {/* Header */}
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

      {/* Sensor Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        {sensors.map((sensor) => {
          const status = getSensorStatus(Number(sensor.value), sensor.min, sensor.max, sensor.isMinOnly);
          const isWarning = status === "warning";

          return (
            <div key={sensor.name} className={`rounded-xl border ${sensor.border} ${sensor.bg} p-3 md:p-4`}>
              <div className="flex items-center justify-between mb-2 md:mb-3">
                <div className={`${sensor.color}`}>
                  {sensor.icon}
                </div>
                {isWarning ? (
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
                {sensor.isMinOnly 
                  ? `> ${sensor.min}${sensor.unit}`
                  : `${sensor.min} - ${sensor.max}${sensor.unit}`
                }
              </div>

              {isWarning && (
                <div className="mt-2 text-xs font-semibold text-red-600">
                  {Number(sensor.value) < sensor.min ? "Below" : "Above"} threshold!
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Device Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs font-bold text-gray-500 uppercase mb-3 flex items-center gap-2">
            <Wifi size={16} />
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
                {data.timestamp ? <TimeAgo timestamp={data.timestamp} /> : "N/A"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}