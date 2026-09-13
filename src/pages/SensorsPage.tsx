// =============================================================================
// src/pages/SensorsPage.tsx
// Live sensor overview: hero status banner, threshold gauge cards per sensor,
// live trend charts, recent readings table, and device/connection details.
// =============================================================================

import { useMemo, useState } from "react";
import {
  Thermometer,
  Waves,
  FlaskConical,
  Radio,
  Activity,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  Database,
  History,
  WifiOff,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { useSensors } from "../hooks/useSensors";
import { LoadingCard, ErrorCard } from "../components/Loading";
import TrendCard from "../components/TrendCard";
import { getSettingsThresholds, getThresholdStatus } from "../types";
import type { ThresholdRange } from "../types";
import { formatFarmDateTime, formatFarmTime } from "../utils/time";
import { buildLiveGuidance } from "../utils/alertGuidance";
import type { AlertGuidance } from "../utils/alertGuidance";
import { FixLegendModal } from "../components/FixLegend";
import type { ChartPoint } from "../types";

// Formats a timestamp into a relative time string (e.g. "5s ago", "3m ago").
function formatTimeAgo(timestamp: string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(date.getTime())) return "N/A";

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

type ParamKey = "temperature" | "water_level" | "ammonia";

const STATUS_PILL: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  critical: "bg-red-100 text-red-700",
};

const STATUS_VALUE: Record<string, string> = {
  good: "text-gray-800",
  warning: "text-amber-600",
  critical: "text-red-600",
};

// Horizontal track showing where the current value sits relative to the safe
// zone (green band) with an out-of-range red marker.
function RangeGauge({ value, range }: { value: number | null; range: ThresholdRange }) {
  const span = Math.max(range.max - range.min, 0.0001);
  const lo = range.min - span * 0.4;
  const hi = range.max + span * 0.4;
  const zone = hi - lo || 1;

  const greenL = ((range.min - lo) / zone) * 100;
  const greenW = (span / zone) * 100;
  const pct = value === null ? null : Math.min(100, Math.max(0, ((value - lo) / zone) * 100));
  const out = value !== null && (value < range.min || value > range.max);

  return (
    <div className="mt-3">
      <div className="relative h-2 rounded-full bg-gray-200/70">
        <div
          className="absolute inset-y-0 rounded-full bg-emerald-200"
          style={{ left: `${greenL}%`, width: `${greenW}%` }}
        />
        {pct !== null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-white shadow"
            style={{ left: `calc(${pct}% - 7px)`, backgroundColor: out ? "#ef4444" : "#10b981" }}
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
        <span className="font-medium">{range.min}</span>
        <span className="font-medium">{range.max}</span>
      </div>
    </div>
  );
}

export default function SensorsPage() {
  const { data, history, connectionStatus, settings, settingsLoading, loading, error, refetch, lastUpdate, consecutiveFailures } = useSensors();
  const [refreshing, setRefreshing] = useState(false);
  const [fixGuidance, setFixGuidance] = useState<AlertGuidance | null>(null);

  const thresholds = useMemo(() => getSettingsThresholds(settings), [settings]);

  const isOnline = connectionStatus === "online";
  const isConnecting = connectionStatus === "connecting";
  const hasData = !!data;
  const isOfflineWithData = !isOnline && !isConnecting && hasData;

  const sensors = useMemo(() => {
    const keys: ParamKey[] = ["temperature", "water_level", "ammonia"];

    const meta: Record<ParamKey, { icon: React.ReactNode; color: string; decimals: number }> = {
      temperature: { icon: <Thermometer size={20} />, color: "text-orange-500", decimals: 1 },
      water_level: { icon: <Waves size={20} />, color: "text-blue-500", decimals: 0 },
      ammonia: { icon: <FlaskConical size={20} />, color: "text-emerald-500", decimals: 2 },
    };

    return keys.map((key) => {
      const threshold = thresholds[key];
      const raw = data?.[key];
      const value = raw !== undefined && raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
      const status = value !== null ? getThresholdStatus(value, threshold.range, threshold.isMinOnly) : "warning";
      const badge = STATUS_PILL[status];
      const valueClass = STATUS_VALUE[status];

      return {
        key,
        name: threshold.name,
        value,
        decimals: meta[key].decimals,
        unit: threshold.unit,
        threshold,
        status,
        outOfRange: value !== null && (value < threshold.range.min || value > threshold.range.max),
        icon: meta[key].icon,
        color: meta[key].color,
        badge,
        valueClass,
      };
    });
  }, [data, thresholds]);

  const recentReadings = useMemo(() => {
    const sorted = [...history].sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
    return sorted.slice(-8).reverse();
  }, [history]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  };

  if (loading && !hasData) {
    return <LoadingCard title="Sensors" message="Loading sensor data..." />;
  }

  if (settingsLoading && !hasData) {
    return <LoadingCard title="Sensors" message="Loading settings..." />;
  }

  if (!hasData && !loading) {
    if (error) {
      return (
        <ErrorCard
          title="Sensors unavailable"
          message="No sensor data could be loaded at this time."
          detail={error}
          onRetry={refetch}
        />
      );
    }
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center shadow-sm">
        <Activity size={40} className="mx-auto mb-3 text-gray-400" />
        <h2 className="mt-0 text-gray-800">Sensors</h2>
        <p className="text-gray-600">No sensor data available yet.</p>
        <p className="text-sm text-gray-500 mt-2">Waiting for ESP32 to send data...</p>
      </div>
    );
  }

  const statusDot = isConnecting
    ? "bg-yellow-500 animate-pulse"
    : isOnline
      ? "bg-emerald-500"
      : isOfflineWithData
        ? "bg-yellow-500"
        : "bg-gray-400";

  const statusText = isConnecting ? "Connecting…" : isOnline ? "Online" : isOfflineWithData ? "Offline — last data" : "Disconnected";

  return (
    <div className="space-y-4">
      {isOfflineWithData && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-yellow-600 shrink-0" />
          <span className="text-xs text-yellow-800">
            ESP32 is offline — showing last known readings. Last update: {lastUpdate ? formatFarmTime(lastUpdate) : "N/A"}
          </span>
        </div>
      )}

      {consecutiveFailures > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-2">
          <ShieldAlert size={16} className="text-red-500 shrink-0" />
          <span className="text-xs text-red-700">
            {consecutiveFailures} consecutive failed updates — device may be unreachable.
          </span>
        </div>
      )}

      {/* Hero status banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-[#d94b1e] via-[#ef6a2e] to-amber-600 text-white shadow-sm">
        <div className="absolute inset-0 opacity-10" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, #fff 0px, transparent 40%)" }} />
        <div className="relative p-6 lg:p-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center">
              <Radio size={26} className={isConnecting ? "text-yellow-400 animate-pulse" : isOnline ? "text-emerald-400" : "text-red-400"} />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                Sensor Status
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-white/10 border border-white/20">
                  <span className={`w-2 h-2 rounded-full ${statusDot}`} />
                  {statusText}
                </span>
              </h1>
              <p className="text-white/70 text-sm mt-1">
                {isOfflineWithData ? "Last known live readings" : "Real-time readings and connection health"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm text-white/80">
            {lastUpdate && (
              <span className="flex items-center gap-1.5">
                <Clock size={14} /> Updated {formatTimeAgo(lastUpdate)}
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-slate-900 text-sm font-semibold hover:bg-orange-50 disabled:opacity-50 transition"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </section>

      {/* Sensor cards */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4 ${isOfflineWithData ? "opacity-70" : ""}`}>
        {sensors.map((sensor) => (
          <div key={sensor.name} className="bg-white rounded-2xl border border-gray-100 p-4 md:p-5 shadow-sm hover:shadow-md transition">
            <div className="flex items-center justify-between mb-2 md:mb-3">
              <div className="flex items-center gap-2">
                <span className={sensor.color}>{sensor.icon}</span>
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{sensor.name}</span>
                <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${sensor.badge}`}>
                  {sensor.status === "good" ? "Safe" : sensor.status === "warning" ? "Warning" : "Critical"}
                </span>
              </div>
              {sensor.outOfRange ? (
                <XCircle size={16} className="text-red-500" />
              ) : (
                <CheckCircle size={16} className="text-green-500" />
              )}
            </div>

            <div className={`text-2xl md:text-3xl font-bold ${sensor.valueClass}`}>
              {sensor.value !== null
                ? `${sensor.value.toFixed(sensor.decimals)}`
                : "--"}
              <span className="text-base font-normal text-gray-500">{sensor.unit}</span>
            </div>

            <div className="mt-2 md:mt-3 text-xs text-gray-500">
              Optimal range:{" "}
              <span className="font-semibold text-gray-700">
                {sensor.threshold.isMinOnly
                  ? `≥ ${sensor.threshold.range.min}${sensor.unit}`
                  : `${sensor.threshold.range.min} – ${sensor.threshold.range.max}${sensor.unit}`}
              </span>
            </div>

            <RangeGauge value={sensor.value} range={sensor.threshold.range} />

            {sensor.outOfRange && sensor.value !== null && (
              <div className="mt-2">
                <p className="text-xs font-semibold text-red-600">
                  {sensor.value < sensor.threshold.range.min ? "Below" : "Above"} threshold — take action
                </p>
                <button
                  onClick={() => {
                    const guidance = buildLiveGuidance(sensor.key, sensor.value, settings);
                    if (guidance) setFixGuidance(guidance);
                  }}
                  className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-orange-50 text-[#c2410c] border border-orange-200 hover:bg-orange-100 transition"
                >
                  <Wrench size={12} />
                  How to fix
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Live trend mini-charts */}
      {history.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-gray-700">Live Trends</h3>
            <span className="text-xs text-gray-400">
              Safe range band (green) with threshold limits
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <TrendCard
              title="Temperature"
              data={history}
              dataKey="temperature"
              stroke="#f97316"
              range={thresholds.temperature.range}
              unit="°C"
            />
            <TrendCard
              title="Water Level"
              data={history}
              dataKey="water_level"
              stroke="#2563eb"
              range={thresholds.water_level.range}
              unit="%"
            />
            <TrendCard
              title="Ammonia"
              data={history}
              dataKey="ammonia"
              stroke="#10b981"
              range={thresholds.ammonia.range}
              unit=" ppm"
            />
          </div>
        </section>
      )}

      {/* Recent readings + device details */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm lg:col-span-2">
          <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700 mb-3">
            <History size={16} className="text-orange-500" />
            Recent Readings
            <span className="ml-auto text-xs font-semibold text-gray-400">
              Last {recentReadings.length} of {history.length} buffered
            </span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-3 py-2.5 text-left text-xs font-bold text-gray-500 uppercase">Time</th>
                  <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Temp</th>
                  <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Level</th>
                  <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Ammonia</th>
                </tr>
              </thead>
              <tbody>
                {recentReadings.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-400">
                      No readings recorded yet
                    </td>
                  </tr>
                )}
                {recentReadings.map((item: ChartPoint, i) => {
                  const t = Number(item.temperature);
                  const w = Number(item.water_level);
                  const a = Number(item.ammonia);
                  const tempOk = Number.isFinite(t) ? getThresholdStatus(t, thresholds.temperature.range, thresholds.temperature.isMinOnly) : "warning";
                  const levelOk = Number.isFinite(w) ? getThresholdStatus(w, thresholds.water_level.range, thresholds.water_level.isMinOnly) : "warning";
                  const ammOk = Number.isFinite(a) ? getThresholdStatus(a, thresholds.ammonia.range, thresholds.ammonia.isMinOnly) : "warning";
                  return (
                    <tr key={item.timestamp ?? i} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap text-xs">
                        {formatFarmDateTime(item.timestamp)}
                      </td>
                      <td className={`px-3 py-2 text-center ${STATUS_VALUE[tempOk]}`}>
                        {Number.isFinite(t) ? `${t.toFixed(1)}°C` : "--"}
                      </td>
                      <td className={`px-3 py-2 text-center ${STATUS_VALUE[levelOk]}`}>
                        {Number.isFinite(w) ? `${w.toFixed(0)}%` : "--"}
                      </td>
                      <td className={`px-3 py-2 text-center ${STATUS_VALUE[ammOk]}`}>
                        {Number.isFinite(a) ? `${a.toFixed(2)} ppm` : "--"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700 mb-3">
            <Database size={16} className="text-emerald-500" />
            Device &amp; Connection
          </h3>
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Device ID</span>
              <span className="font-semibold text-gray-800">{data?.device_id || "--"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Connection</span>
              <span className={`font-semibold ${isOnline ? "text-emerald-600" : isConnecting ? "text-yellow-600" : "text-red-600"}`}>
                {isConnecting ? "Connecting" : isOnline ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Buffered readings</span>
              <span className="font-semibold text-gray-800">{history.length}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Failed updates</span>
              <span className={`font-semibold ${consecutiveFailures > 0 ? "text-red-600" : "text-gray-800"}`}>
                {consecutiveFailures}
              </span>
            </div>
            <div className="pt-3 mt-3 border-t border-gray-100">
              <p className="text-gray-500 text-xs mb-1">Received at</p>
              <p className="font-semibold text-gray-800 text-sm">
                {data?.timestamp ? formatFarmDateTime(data.timestamp) : "N/A"}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-gray-400 mt-1">
                {isOnline || isOfflineWithData ? (
                  <WifiOff size={12} className={isOnline ? "hidden" : "inline text-yellow-500"} />
                ) : (
                  <Activity size={12} className="text-gray-400" />
                )}
                {lastUpdate ? `Updated ${formatTimeAgo(lastUpdate)}` : "No updates yet"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Fix guidance modal (opened via "How to fix" on an out-of-range card) */}
      {fixGuidance && (
        <FixLegendModal guidance={fixGuidance} onClose={() => setFixGuidance(null)} />
      )}
    </div>
  );
}