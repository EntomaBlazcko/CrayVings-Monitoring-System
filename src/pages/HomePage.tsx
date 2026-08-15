// =============================================================================
// FILE: src/pages/HomePage.tsx
// =============================================================================
// PURPOSE: Landing/overview page of the CRAYvings Monitoring System.
//
// This is the default page shown after login. It provides:
//   1. Hero banner with connection status badge and tank safety status
//   2. Three gradient stat cards showing live temperature, water level, and ammonia
//   3. System alerts sidebar showing active threshold breaches
//   4. Quick controls panel (refresh data, dismiss alerts, go to settings)
//   5. Key metrics summary section with optimal ranges
//
// The page is a high-level overview - users can drill down into specific
// data via the sidebar navigation (Dashboard, Sensors, Historical Data, etc.).
//
// DATA SOURCES:
//   - useSensors hook (sensor data, settings, connection status)
//   - Threshold evaluation for tank safety assessment
// =============================================================================

import { useState, useMemo } from "react";
import { Thermometer, Waves, FlaskConical, AlertTriangle, AlertCircle, CheckCircle, RefreshCw, BellOff, Settings } from "lucide-react";
import type { MenuKey } from "../types";
import { useSensors } from "../hooks/useSensors";
import { getSettingsThresholds, getThresholdStatus } from "../types";

type Props = {
  onNavigate?: (menu: MenuKey) => void;
};

type Stat = {
  title: string;
  value: string;
  description: string;
  gradient: string;
  icon: React.ReactNode;
  loading?: boolean;
};

function StatCard({ title, value, description, gradient, icon, loading = false }: Stat) {
  return (
    <div className={`rounded-2xl bg-gradient-to-r ${gradient} p-5 text-white shadow-sm`}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/90">{title}</p>
        <div className="text-white/80">{icon}</div>
      </div>
      <h3 className={`mt-2 text-3xl font-bold ${loading ? "animate-pulse" : ""}`}>{value}</h3>
      <p className="mt-2 text-sm text-white/90">{description}</p>
    </div>
  );
}

export default function HomePage({ onNavigate }: Props) {
  const { data, refetch, settings, loading, connectionStatus, lastUpdate } = useSensors();
  const [alertsDismissed, setAlertsDismissed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const thresholds = useMemo(() => getSettingsThresholds(settings), [settings]);
  
  const isOnline = connectionStatus === "online";
  const isConnecting = connectionStatus === "connecting";
  const hasData = !!data;
  const isOfflineWithData = !isOnline && !isConnecting && hasData;
  
  const tankStatus = useMemo(() => {
    if (!hasData) return { safe: false, alerts: ["No sensor data"] };
    
    const alerts: string[] = [];
    const sensorKeys = ["temperature", "water_level", "ammonia"] as const;
    
    for (const key of sensorKeys) {
      const threshold = thresholds[key];
      const value = data[key];
      const status = getThresholdStatus(value, threshold.range, threshold.isMinOnly);
      
      if (status === "warning" || status === "critical") {
        const direction = value < threshold.range.min ? "low" : "high";
        alerts.push(`${threshold.name} ${direction} at ${value}${threshold.unit}`);
      }
    }
    
    return {
      safe: alerts.length === 0,
      alerts: alerts.length > 0 ? alerts : ["Tank is Safe"],
    };
  }, [data, thresholds, hasData]);

  const getStatusBadge = () => {
    if (loading) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-600">
          <RefreshCw size={14} className="animate-spin" />
          Loading...
        </span>
      );
    }
    if (isOfflineWithData) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700">
          <AlertCircle size={14} />
          Offline - Last Data
        </span>
      );
    }
    if (!hasData && !loading) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
          <AlertCircle size={14} />
          No Data
        </span>
      );
    }
    if (tankStatus.safe && isOnline) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">
          <CheckCircle size={14} />
          Tank Safe
        </span>
      );
    }
    if (hasData && !tankStatus.safe) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
          <AlertTriangle size={14} />
          Attention Needed
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
        <AlertCircle size={14} />
        Unknown
      </span>
    );
  };

  const getConnectionStatusDot = () => {
    if (loading) return "bg-blue-500 animate-pulse";
    if (isOfflineWithData) return "bg-yellow-500";
    if (isOnline) return "bg-emerald-500";
    if (isConnecting) return "bg-yellow-500 animate-pulse";
    return "bg-gray-400";
  };

  const getCardGradient = (defaultGradient: string) => {
    if (loading) return "from-gray-400 to-gray-500";
    if (isOfflineWithData) return "from-yellow-400 to-yellow-500";
    return defaultGradient;
  };

  const stats: Stat[] = [
    {
      title: "Water Temperature",
      value: loading ? "Loading..." : data ? `${data.temperature}°C` : "--°C",
      description: `Threshold: ${thresholds.temperature.range.min}-${thresholds.temperature.range.max}°C`,
      gradient: getCardGradient("from-blue-500 to-cyan-500"),
      icon: <Thermometer size={24} />,
    },
    {
      title: "Water Level",
      value: loading ? "Loading..." : data ? `${data.water_level}%` : "--%",
      description: `Threshold: ${thresholds.water_level.range.min}-${thresholds.water_level.range.max}%`,
      gradient: getCardGradient("from-indigo-500 to-blue-500"),
      icon: <Waves size={24} />,
    },
    {
      title: "Ammonia",
      value: loading ? "Loading..." : data ? `${data.ammonia} mg/L` : "-- mg/L",
      description: `Threshold: ${thresholds.ammonia.range.min}-${thresholds.ammonia.range.max} mg/L`,
      gradient: getCardGradient("from-emerald-500 to-teal-500"),
      icon: <FlaskConical size={24} />,
    },
  ];

  const highlights = [
    { label: "Temperature", value: loading ? "..." : data ? `${data.temperature}°C` : "--", color: isOfflineWithData ? "bg-yellow-50 border-yellow-200 text-yellow-700" : data ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-red-50 border-red-200 text-red-700" },
    { label: "Water Level", value: loading ? "..." : data ? `${data.water_level}%` : "--", color: isOfflineWithData ? "bg-yellow-50 border-yellow-200 text-yellow-700" : data ? "bg-indigo-50 border-indigo-200 text-indigo-700" : "bg-red-50 border-red-200 text-red-700" },
    { label: "Ammonia", value: loading ? "..." : data ? `${data.ammonia} mg/L` : "--", color: isOfflineWithData ? "bg-yellow-50 border-yellow-200 text-yellow-700" : data ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-red-50 border-red-200 text-red-700" },
  ];

  const recentAlerts = tankStatus.alerts.filter(alert => alert !== "Tank is Safe").slice(0, 4);

  return (
    <div className="space-y-6">
      {isOfflineWithData && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-yellow-600 shrink-0" />
          <span className="text-xs text-yellow-800">
            ESP32 is offline — showing last known readings. Last update: {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "N/A"}
          </span>
        </div>
      )}

      <section className="relative overflow-hidden rounded-3xl border border-gray-200 bg-gradient-to-r from-cyan-50 via-blue-50 to-orange-50 shadow-sm">
        <div
          className="absolute inset-0 bg-cover bg-center opacity-10"
          style={{ backgroundImage: "url('/crayvings background.png')" }}
        />
        <div className="absolute inset-0 bg-white/20" />

        <div className="relative grid grid-cols-1 gap-6 p-6 lg:grid-cols-3 lg:p-8">
          <div className="flex flex-col justify-center lg:col-span-2">
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span className="inline-flex w-fit rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                Smart Aquaculture Dashboard
              </span>
              {getStatusBadge()}
              <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                <span className={`w-2 h-2 rounded-full ${getConnectionStatusDot()}`} />
                {isOnline ? "Connected" : isConnecting ? "Connecting..." : isOfflineWithData ? "Offline" : "Disconnected"}
              </span>
              {lastUpdate && !loading && (
                <span className="text-xs text-gray-400">
                  Last updated: {new Date(lastUpdate).toLocaleTimeString()}
                </span>
              )}
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
              ) : loading ? (
                <p className="text-sm text-gray-400">Loading alerts...</p>
              ) : !hasData ? (
                <div className="rounded-lg p-3 font-bold text-sm bg-red-100 text-red-700">
                  No sensor data available. Waiting for ESP32.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {tankStatus.alerts.filter(alert => alert !== "Tank is Safe").length > 0 ? (
                    tankStatus.alerts.filter(alert => alert !== "Tank is Safe").map((alert, index) => (
                      <div
                        key={index}
                        className="rounded-lg p-3 font-bold text-sm bg-red-100 text-red-700"
                      >
                        {alert}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg p-3 font-bold text-sm bg-emerald-100 text-emerald-700">
                      Tank is Safe
                    </div>
                  )}
                </div>
              )}
            </aside>
        </div>
      </section>

      {hasData && !tankStatus.safe && (
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

      <section className={`grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 ${isOfflineWithData ? "opacity-60" : ""}`}>
        {stats.map((stat) => (
          <StatCard key={stat.title} {...stat} loading={loading} />
        ))}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-1">
          <h3 className="mb-4 text-lg font-bold text-gray-800">Quick Controls</h3>
          <div className="flex flex-col gap-3">
            <button
              onClick={async () => {
                setIsRefreshing(true);
                try {
                  await refetch();
                } finally {
                  setIsRefreshing(false);
                }
              }}
              disabled={isRefreshing || loading}
              className="flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              {isRefreshing ? "Refreshing..." : "Refresh Data"}
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
          {!hasData ? (
            <div className="rounded-lg p-3 font-bold text-sm bg-gray-100 text-gray-600 text-center">
              No sensor data available yet.
            </div>
          ) : (
            <div className={`grid grid-cols-1 gap-4 sm:grid-cols-3 ${isOfflineWithData ? "opacity-60" : ""}`}>
              <div className="rounded-xl bg-blue-50 p-4">
                <p className="text-xs text-gray-500">Temperature</p>
                <p className="mt-1 text-2xl font-bold text-blue-600">{data?.temperature ?? "--"}°C</p>
                <p className="mt-1 text-xs text-gray-400">
                  Optimal: {thresholds.temperature.range.min}-{thresholds.temperature.range.max}°C
                </p>
              </div>
              <div className="rounded-xl bg-indigo-50 p-4">
                <p className="text-xs text-gray-500">Water Level</p>
                <p className="mt-1 text-2xl font-bold text-indigo-600">{data?.water_level ?? "--"}%</p>
                <p className="mt-1 text-xs text-gray-400">
                  Optimal: {thresholds.water_level.range.min}-{thresholds.water_level.range.max}%
                </p>
              </div>
              <div className="rounded-xl bg-emerald-50 p-4">
                <p className="text-xs text-gray-500">Ammonia</p>
                <p className="mt-1 text-2xl font-bold text-emerald-600">{data?.ammonia ?? "--"} mg/L</p>
                <p className="mt-1 text-xs text-gray-400">
                  Optimal: {thresholds.ammonia.range.min}-{thresholds.ammonia.range.max} mg/L
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
