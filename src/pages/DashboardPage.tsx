// =============================================================================
// FILE: src/pages/DashboardPage.tsx
// =============================================================================
// PURPOSE: Main monitoring dashboard with live readings and trend charts.
//
// This page provides a comprehensive real-time view of the aquaculture system:
//   1. Three StatCards showing current temperature, water level, and ammonia
//   2. Three TrendCards with line charts showing historical trends
//   3. Sensor Hub Status panel showing ESP32 connection state
//   4. Recent Readings table with the last 5 sensor entries
//   5. Tank Status indicator (safe vs alert) with detail messages
//
// LAYOUT: 3-column grid on desktop (status | readings | tank status)
// DATA: Real-time from SensorProvider (3-second polling)
// =============================================================================

import { useMemo } from "react";
import { Thermometer, Waves, FlaskConical, AlertTriangle } from "lucide-react";
import StatCard from "../components/StatCard";
import TrendCard from "../components/TrendCard";
import { Skeleton } from "../components/Loading";
import { useSensors } from "../hooks/useSensors";
import { getSettingsThresholds, getThresholdStatus } from "../types";

export default function DashboardPage() {
  const { data, history, connectionStatus, lastUpdate, settings, loading } = useSensors();
  
  const thresholds = useMemo(() => getSettingsThresholds(settings), [settings]);
  
  const isOnline = connectionStatus === "online";
  const isConnecting = connectionStatus === "connecting";
  const hasData = !!data;
  const isOfflineWithData = !isOnline && !isConnecting && hasData;
  const offlineClass = isOfflineWithData ? "opacity-60" : "";
  
  const tankStatus = useMemo(() => {
    if (!data) return { safe: false, messages: ["No sensor data"] };
    
    const messages: string[] = [];
    const sensorKeys = ["temperature", "water_level", "ammonia"] as const;
    
    for (const key of sensorKeys) {
      const threshold = thresholds[key];
      const value = data[key];
      const status = getThresholdStatus(value, threshold.range, threshold.isMinOnly);
      
      if (status === "warning" || status === "critical") {
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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:gap-3 mb-4">
        <div className={offlineClass}>
          <StatCard
            title="Temperature"
            value={data ? `${data.temperature}°C` : "--°C"}
            loading={loading}
            color={loading ? "#9ca3af" : isOfflineWithData ? "#9ca3af" : data ? "#f97316" : "#ef4444"}
            icon={<Thermometer size={18} />}
          />
        </div>
        <div className={offlineClass}>
          <StatCard
            title="Water Level"
            value={data ? `${data.water_level}%` : "--%"}
            loading={loading}
            color={loading ? "#9ca3af" : isOfflineWithData ? "#9ca3af" : data ? "#2563eb" : "#ef4444"}
            icon={<Waves size={18} />}
          />
        </div>
        <div className={offlineClass}>
          <StatCard
            title="Ammonia"
            value={data ? `${data.ammonia} ppm` : "-- ppm"}
            loading={loading}
            color={loading ? "#9ca3af" : isOfflineWithData ? "#9ca3af" : data ? "#10b981" : "#ef4444"}
            icon={<FlaskConical size={18} />}
          />
        </div>
      </div>

      {isOfflineWithData && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 mb-4 flex items-center gap-2">
          <AlertTriangle size={16} className="text-yellow-600 shrink-0" />
          <span className="text-xs text-yellow-800">
            ESP32 is offline — showing last known readings from {lastUpdate?.toLocaleTimeString()}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {loading ? (
          <>
            {["Temperature", "Water Level", "Ammonia"].map((title) => (
              <div key={title} className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm" aria-busy="true">
                <div className="flex items-center justify-between mb-3">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-10" />
                </div>
                <Skeleton className="h-[180px] w-full" />
              </div>
            ))}
          </>
        ) : (
          <>
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
              title="Ammonia"
              data={history}
              dataKey="ammonia"
              stroke="#10b981"
            />
          </>
        )}
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
              className={`w-2.5 h-2.5 rounded-full ${
                isConnecting ? "bg-yellow-500 animate-pulse" : isOnline ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className={`text-xs font-bold ${
              isConnecting ? "text-yellow-600" : isOnline ? "text-green-600" : "text-red-600"
            }`}>
              {isConnecting ? "CONNECTING..." : isOnline ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-4">
            Updated: {loading ? "Loading..." : lastUpdate ? lastUpdate.toLocaleTimeString() : "N/A"}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm overflow-auto md:col-span-6">
          <div className="text-xs font-bold text-gray-500 mb-3">
            Recent Readings
          </div>
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-3 flex-1" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="text-xs text-gray-400 py-4 text-center">No readings available</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[200px]">
                <thead className="text-gray-500">
                  <tr>
                    <th className="text-left py-1">Time</th>
                    <th className="text-center py-1">Temp</th>
                    <th className="text-center py-1">Level</th>
                    <th className="text-center py-1">Ammonia</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(-5).reverse().map((h, i) => (
                    <tr key={i} className="border-t">
                      <td className="py-1">{new Date(h.timestamp).toLocaleTimeString()}</td>
                      <td className="text-center py-1">{h.temperature != null ? `${h.temperature}°C` : "--"}</td>
                      <td className="text-center py-1">{h.water_level != null ? `${h.water_level}%` : "--"}</td>
                      <td className="text-center py-1">{h.ammonia != null ? `${h.ammonia} ppm` : "--"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 md:col-span-3">
          <div className="bg-white rounded-xl border border-gray-100 p-3 shadow-sm">
            <div className="text-xs font-bold text-gray-500 mb-2">
              Tank Status
            </div>
            {loading ? (
              <Skeleton className="h-7 w-full" />
            ) : !data ? (
              <div className="rounded-lg p-2 text-xs font-bold text-center bg-red-100 text-red-700">
                Connection Error
              </div>
            ) : (
              <>
                <div className={`rounded-lg p-2 text-xs font-bold text-center ${
                  tankStatus.safe 
                    ? "bg-emerald-100 text-emerald-700" 
                    : "bg-red-100 text-red-700"
                }`}>
                  {tankStatus.safe ? "Tank is Safe" : "Alert: Check parameters"}
                </div>
                {!tankStatus.safe && tankStatus.messages.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {tankStatus.messages.map((msg, i) => (
                      <div key={i} className="text-xs text-red-600 flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-red-500" />
                        {msg}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className={`${isOfflineWithData ? "bg-gray-50 border-gray-200" : "bg-orange-50 border-orange-200"} rounded-xl border p-3 shadow-sm`}>
            <div className="flex items-center gap-2 mb-2 text-orange-600 font-bold text-xs">
              <AlertTriangle size={14} />
              Temperature
            </div>
            <div className={`text-2xl md:text-3xl font-extrabold ${data ? "text-red-500" : "text-gray-400"}`}>
              {loading ? "..." : data ? `${data.temperature}°C` : "--°C"}
            </div>
            <div className={`text-xs mt-1 ${isOfflineWithData ? "text-gray-400" : "text-orange-800"}`}>
              {loading ? "Fetching..." : isOfflineWithData ? "Last known reading (offline)" : "Real-time monitoring"}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
