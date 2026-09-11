// =============================================================================
// src/pages/AnalyticsPage.tsx
// Analytics dashboard: period summary, trends, alerts, device uptime, and
// rule-engine suggestions. Read-only and available to every logged-in role.
// =============================================================================

import { useState, useEffect, useMemo } from "react";
import {
  BarChart3,
  Thermometer,
  Waves,
  FlaskConical,
  AlertTriangle,
  WifiOff,
  Activity,
  CheckCircle2,
  Info,
  Lightbulb,
  RefreshCw,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { LoadingCard, ErrorCard } from "../components/Loading";
import { fetchAnalyticsOverview, fetchAnalyticsDaily, fetchAnalyticsInsights } from "../api/client";
import { isAxiosError } from "axios";
import type { AnalyticsOverview, AnalyticsDailyEntry, Insight } from "../types";

type RangeKey = 7 | 30 | 90;

const RANGES: { value: RangeKey; label: string }[] = [
  { value: 7, label: "7 Days" },
  { value: 30, label: "30 Days" },
  { value: 90, label: "90 Days" },
];

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "AbortError";
  return isAxiosError(err) && (err.code === "ERR_CANCELED" || err.name === "CanceledError");
}

// Severity styling for suggestion cards.
const INSIGHT_STYLES: Record<Insight["level"], { ring: string; icon: string; label: string; badge: string }> = {
  critical: {
    ring: "border-red-200 bg-red-50",
    icon: "bg-red-100 text-red-600",
    label: "Critical",
    badge: "bg-red-600 text-white",
  },
  warning: {
    ring: "border-amber-200 bg-amber-50",
    icon: "bg-amber-100 text-amber-600",
    label: "Warning",
    badge: "bg-amber-500 text-white",
  },
  info: {
    ring: "border-blue-200 bg-blue-50",
    icon: "bg-blue-100 text-blue-600",
    label: "Info",
    badge: "bg-blue-500 text-white",
  },
};

function InsightIcon({ level }: { level: Insight["level"] }) {
  const style = INSIGHT_STYLES[level];
  if (level === "critical") return <AlertTriangle size={18} className={style.icon} />;
  if (level === "warning") return <AlertTriangle size={18} className={style.icon} />;
  return <Info size={18} className={style.icon} />;
}

// Builds recharts points from daily aggregates.
function toChartPoints(daily: AnalyticsDailyEntry[]) {
  return daily.map((d) => ({
    name: d.date,
    date: d.date,
    temp: Number(d.temp_avg) || 0,
    water: Number(d.water_avg) || 0,
    ammonia: Number(d.ammonia_avg) || 0,
    readings: d.readings || 0,
    alerts: d.alerts || 0,
  }));
}

// Param card: name, unit, color, average + trend badge.
function ParamCard({
  name,
  unit,
  avg,
  min,
  max,
  changePct,
  direction,
  icon,
  colorClass,
}: {
  name: string;
  unit: string;
  avg: number;
  min: number;
  max: number;
  changePct: number;
  direction: "up" | "down" | "stable";
  icon: React.ReactNode;
  colorClass: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-gray-500">
          <span className={colorClass}>{icon}</span>
          <span className="text-xs font-semibold uppercase tracking-wide">{name}</span>
        </div>
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded-full ${
            direction === "up"
              ? "bg-red-100 text-red-700"
              : direction === "down"
                ? "bg-blue-100 text-blue-700"
                : "bg-gray-100 text-gray-500"
          }`}
          title={`Change vs previous period: ${changePct}%`}
        >
          {direction === "stable" ? "stable" : `${direction === "up" ? "▲" : "▼"} ${Math.abs(changePct)}%`}
        </span>
      </div>
      <div className="text-2xl font-bold text-gray-800">
        {avg.toFixed(name === "Ammonia" ? 2 : 1)}
        <span className="text-base font-normal text-gray-500">{unit}</span>
      </div>
      <div className="text-xs text-gray-400 mt-1">
        Range {min.toFixed(name === "Ammonia" ? 2 : 1)} – {max.toFixed(name === "Ammonia" ? 2 : 1)} {unit}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>(7);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [daily, setDaily] = useState<AnalyticsDailyEntry[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  // Fetch all three datasets for the selected range (abortable).
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    Promise.all([fetchAnalyticsOverview(range, controller.signal), fetchAnalyticsDaily(range, controller.signal)])
      .then(([ov, dailyRes]) => {
        setOverview(ov);
        setDaily(dailyRes.daily || []);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) {
          setError((err as Error)?.message || "Failed to load analytics data.");
          setLoading(false);
        }
      });

    fetchAnalyticsInsights(range, controller.signal)
      .then((res) => setInsights(res.insights || []))
      .catch(() => {
        /* insights are optional — charts still render if they fail */
      });

    return () => controller.abort();
  }, [range, retry]);

  const chartData = useMemo(() => toChartPoints(daily), [daily]);

  if (loading && !overview) {
    return (
      <LoadingCard title="Analytics" message="Analyzing sensor data..." />
    );
  }

  if (error && !overview) {
    return (
      <ErrorCard
        title="Failed to load analytics"
        message="We couldn't reach the server. Please check your connection and try again."
        detail={error}
        onRetry={() => setRetry((n) => n + 1)}
      />
    );
  }

  if (!overview) return null;

  const { summary, trends, alerts, uptime } = overview;
  const bySeverity = (level: Insight["level"]) => insights.filter((i) => i.level === level);
  const orderedInsights = [...insights].sort((a, b) => {
    const order: Record<Insight["level"], number> = { critical: 0, warning: 1, info: 2 };
    return order[a.level] - order[b.level];
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <BarChart3 size={22} className="text-orange-500" />
              Analytics
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              Period trends, alert activity, and suggested actions
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  range === r.value
                    ? "bg-blue-500 text-white shadow-sm"
                    : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100"
                }`}
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={() => setRetry((n) => n + 1)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-[#c2410c] text-white hover:bg-[#a13a0a] transition"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-gray-400">
          Window: {new Date(overview.period.start).toLocaleDateString()} – {new Date(overview.period.end).toLocaleDateString()} · {overview.days} days
        </div>
      </div>

      {/* Param summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <ParamCard
          name="Temperature"
          unit="°C"
          icon={<Thermometer size={16} className="text-orange-500" />}
          avg={summary.temperature.avg}
          min={summary.temperature.min}
          max={summary.temperature.max}
          changePct={trends.temperature.change_pct}
          direction={trends.temperature.direction}
          colorClass="text-orange-500"
        />
        <ParamCard
          name="Water Level"
          unit="%"
          icon={<Waves size={16} className="text-blue-500" />}
          avg={summary.water_level.avg}
          min={summary.water_level.min}
          max={summary.water_level.max}
          changePct={trends.water_level.change_pct}
          direction={trends.water_level.direction}
          colorClass="text-blue-500"
        />
        <ParamCard
          name="Ammonia"
          unit=" ppm"
          icon={<FlaskConical size={16} className="text-emerald-500" />}
          avg={summary.ammonia.avg}
          min={summary.ammonia.min}
          max={summary.ammonia.max}
          changePct={trends.ammonia.change_pct}
          direction={trends.ammonia.direction}
          colorClass="text-emerald-500"
        />
      </div>

      {/* Uptime + alerts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-2">
            {uptime.device_offline ? (
              <WifiOff size={16} className="text-red-500" />
            ) : (
              <Activity size={16} className="text-green-500" />
            )}
            <span className="text-xs font-semibold uppercase tracking-wide">Device</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`font-bold text-xl ${uptime.device_offline ? "text-red-600" : "text-gray-800"}`}>
              {uptime.device_offline ? "Offline" : "Online"}
            </span>
          </div>
          <div className="text-xs text-gray-400 mt-2 space-y-0.5">
            <p>{uptime.readings.toLocaleString()} readings in window</p>
            <p>
              Last data: {uptime.last_reading ? new Date(uptime.last_reading).toLocaleString() : "none"}
            </p>
            {uptime.gap_events > 0 && (
              <p className="text-amber-600">{uptime.gap_events} connection gap(s) detected</p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-2">
            <AlertTriangle size={16} className="text-amber-500" />
            <span className="text-xs font-semibold uppercase tracking-wide">Alerts</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-xl text-gray-800">{alerts.total}</span>
            <span className="text-xs text-gray-400">in window</span>
            {alerts.resolved > 0 && (
              <span className="ml-auto flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 size={14} /> {alerts.resolved} resolved
              </span>
            )}
          </div>
          {Object.keys(alerts.by_parameter).length > 0 ? (
            <div className="flex flex-wrap gap-2 mt-2">
              {Object.entries(alerts.by_parameter).map(([param, count]) => (
                <span key={param} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-100">
                  {param}: {count}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400 mt-2">No alerts triggered in this period.</p>
          )}
        </div>
      </div>

      {/* Suggestions panel */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
          <Lightbulb size={20} className="text-amber-500" />
          Suggestions
          <span className="ml-auto text-sm font-semibold text-[#c2410c] bg-orange-50 rounded-full px-3 py-1">
            {insights.length > 0 ? `${insights.length} insight${insights.length === 1 ? "" : "s"}` : "No insights"}
          </span>
        </h2>

        {insights.length === 0 ? (
          <div className="text-center py-6">
            <CheckCircle2 size={32} className="mx-auto mb-2 text-green-400" />
            <p className="text-gray-500 text-sm">
              Everything looks nominal — no suggestions triggered for this period.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {orderedInsights.map((insight, i) => {
              const style = INSIGHT_STYLES[insight.level];
              return (
                <div key={`${insight.title}-${i}`} className={`border rounded-xl p-3.5 flex gap-3 ${style.ring}`}>
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${style.icon}`}>
                    <InsightIcon level={insight.level} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-sm text-gray-800">{insight.title}</h3>
                      <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${style.badge}`}>
                        {style.label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">{insight.message}</p>
                    {insight.action && (
                      <p className="text-xs text-[#c2410c] mt-1 font-medium">{insight.action}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Daily trend chart */}
      {chartData.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <h2 className="text-lg font-bold text-gray-800 mb-4">Daily Averages</h2>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                interval={Math.max(0, Math.floor(chartData.length / 10) - 1)}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
                width={40}
                yAxisId="left"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
                width={40}
                yAxisId="right"
                orientation="right"
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const selected = daily.find((d) => d.date === label);
                  return (
                    <div className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm text-xs">
                      <p className="font-semibold text-gray-800 mb-1">{label}</p>
                      {payload.map((p) => (
                        <p key={String(p.dataKey)} className="text-gray-600">
                          <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: p.color }} />
                          {p.name}: {p.value != null ? Number(p.value).toFixed(2) : "—"}
                        </p>
                      ))}
                      {selected && (
                        <>
                          <p className="text-gray-400 mt-1">{selected.readings.toLocaleString()} readings</p>
                          <p className="text-gray-700">Alerts: {selected.alerts}</p>
                        </>
                      )}
                    </div>
                  );
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="left" type="monotone" dataKey="temp" name="Temperature (°C)" stroke="#f97316" strokeWidth={2} dot={false} />
              <Line yAxisId="left" type="monotone" dataKey="water" name="Water Level (%)" stroke="#2563eb" strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="ammonia" name="Ammonia (ppm)" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Severity summary */}
      {(bySeverity("critical").length > 0 || bySeverity("warning").length > 0) && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <h2 className="text-lg font-bold text-gray-800 mb-3">Priority Summary</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-red-50 border border-red-100 rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-red-700">{bySeverity("critical").length}</div>
              <div className="text-xs text-red-600 mt-1">Critical</div>
            </div>
            <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-amber-700">{bySeverity("warning").length}</div>
              <div className="text-xs text-amber-600 mt-1">Warnings</div>
            </div>
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-center">
              <div className="text-2xl font-bold text-blue-700">{bySeverity("info").length}</div>
              <div className="text-xs text-blue-600 mt-1">Info</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}