// =============================================================================
// src/components/AnalyticsSection.tsx
// Analytics dashboard: period summary with threshold status, trends, alert
// activity, device uptime, daily readings/alerts volume, a focusable daily
// averages chart (with configured safe-range band + rolling average), and
// rule-engine suggestions.
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
  Flame,
  Snowflake,
  BellRing,
  Database,
} from "lucide-react";
import {
  ComposedChart,
  Bar,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { LoadingCard, ErrorCard } from "./Loading";
import { fetchAnalyticsOverview, fetchAnalyticsDaily, fetchAnalyticsInsights } from "../api/client";
import { useSensors } from "../hooks/useSensors";
import { isAxiosError } from "axios";
import type { AnalyticsOverview, AnalyticsDailyEntry, Insight } from "../types";
import { getSettingsThresholds, getThresholdStatus, SENSOR_KEY_TO_DISPLAY } from "../types";
import { formatFarmDateTime, formatFarmDate } from "../utils/time";

type RangeKey = 7 | 30 | 90;
type ParamKey = "temperature" | "water_level" | "ammonia";

const RANGES: { value: RangeKey; label: string }[] = [
  { value: 7, label: "7 Days" },
  { value: 30, label: "30 Days" },
  { value: 90, label: "90 Days" },
];

// Series used purely for the safe band + limit lines (filtered from tooltips).
const BAND_KEYS = ["bandMin", "bandMax"];

const PARAM_META: Record<ParamKey, { label: string; unit: string; color: string; icon: React.ReactNode; yAxisId: string }> = {
  temperature: { label: "Temperature", unit: "°C", color: "#f97316", icon: <Thermometer size={14} />, yAxisId: "left" },
  // Water Level gets its own (hidden) axis so % doesn't share a scale with °C.
  water_level: { label: "Water Level", unit: "%", color: "#2563eb", icon: <Waves size={14} />, yAxisId: "water" },
  ammonia: { label: "Ammonia", unit: "ppm", color: "#10b981", icon: <FlaskConical size={14} />, yAxisId: "right" },
};

const STATUS_TEXT: Record<string, string> = {
  good: "text-gray-800",
  warning: "text-amber-600",
  critical: "text-red-600",
};

const STATUS_PILL: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  critical: "bg-red-100 text-red-700",
};

const STATUS_LABEL: Record<string, string> = {
  good: "Safe",
  warning: "Warning",
  critical: "Critical",
};

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
    ring: "border-orange-200 bg-orange-50",
    icon: "bg-orange-100 text-orange-600",
    label: "Info",
    badge: "bg-orange-500 text-white",
  },
};

function InsightIcon({ level }: { level: Insight["level"] }) {
  if (level === "critical") return <AlertTriangle size={18} className={INSIGHT_STYLES.critical.icon} />;
  if (level === "warning") return <AlertTriangle size={18} className={INSIGHT_STYLES.warning.icon} />;
  return <Info size={18} className={INSIGHT_STYLES.info.icon} />;
}

// Builds recharts points from daily aggregates (defensive Number coercion for
// DECIMAL columns that pg returns as strings).
function toChartPoints(daily: AnalyticsDailyEntry[]) {
  return daily.map((d) => ({
    name: d.date,
    date: d.date,
    temp: Number(d.temp_avg) || 0,
    water: Number(d.water_avg) || 0,
    ammonia: Number(d.ammonia_avg) || 0,
    readings: Number(d.readings) || 0,
    alerts: Number(d.alerts) || 0,
  }));
}

// 7-day (rolling) window average over a numeric series.
function rollingAvg(values: (number | null)[], window = 7): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    const nums = slice.filter((v): v is number => typeof v === "number");
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  });
}

function formatAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Compact axis label for chart dates (full dates render in list/tooltip views).
function fmtAxisDate(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Param card: name, unit, status pill, average + trend badge, min/max range,
// configured safe range, and how many days the daily average sat outside it.
function ParamCard({
  name,
  unit,
  avg,
  min,
  max,
  changePct,
  direction,
  icon,
  status,
  safeRange,
  breach,
}: {
  name: string;
  unit: string;
  avg: number;
  min: number;
  max: number;
  changePct: number;
  direction: "up" | "down" | "stable";
  icon: React.ReactNode;
  status: "good" | "warning" | "critical";
  safeRange: { min: number; max: number };
  breach: { below: number; above: number };
}) {
  const decimals = name === "Ammonia" ? 2 : 1;
  const breached = breach.below > 0 || breach.above > 0;
  return (
    <div className={`bg-white rounded-xl border p-4 hover:shadow-sm transition ${breached ? "border-amber-200" : "border-gray-100"}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-gray-500">
          {icon}
          <span className="text-xs font-semibold uppercase tracking-wide">{name}</span>
          <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[status]}`}>
            {STATUS_LABEL[status]}
          </span>
        </div>
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded-full ${
            direction === "up"
              ? "bg-red-100 text-red-700"
              : direction === "down"
                ? "bg-orange-100 text-orange-700"
                : "bg-gray-100 text-gray-500"
          }`}
          title={`Change vs previous period: ${changePct}%`}
        >
          {direction === "stable" ? "stable" : `${direction === "up" ? "▲" : "▼"} ${Math.abs(changePct)}%`}
        </span>
      </div>
      <div className={`text-2xl font-bold ${STATUS_TEXT[status]}`}>
        {avg.toFixed(decimals)}
        <span className="text-base font-normal text-gray-500">{unit}</span>
      </div>
      <div className="text-xs text-gray-400 mt-1">
        Period range {min.toFixed(decimals)} – {max.toFixed(decimals)} {unit}
      </div>
      {breached ? (
        <div className="mt-2 border-t border-gray-100 pt-2">
          <div className="text-[10px] text-gray-400 mb-1">
            Safe range: {safeRange.min} – {safeRange.max} {unit}
          </div>
          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${breach.below > 0 && breach.above > 0 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
            <AlertTriangle size={10} />
            {breach.below > 0 && breach.above > 0
              ? `${breach.below} below · ${breach.above} above`
              : breach.below > 0
                ? `${breach.below} day${breach.below === 1 ? "" : "s"} below safe range`
                : `${breach.above} day${breach.above === 1 ? "" : "s"} above safe range`}
          </span>
        </div>
      ) : (
        <div className="mt-2 border-t border-gray-100 pt-2">
          <div className="text-[10px] text-gray-400 mb-1">
            Safe range: {safeRange.min} – {safeRange.max} {unit}
          </div>
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600">
            <CheckCircle2 size={10} /> all days within safe range
          </span>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsSection() {
  const [range, setRange] = useState<RangeKey>(7);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [daily, setDaily] = useState<AnalyticsDailyEntry[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [focused, setFocused] = useState<ParamKey | null>(null);
  const { settings } = useSensors();

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

  const thresholds = useMemo(() => getSettingsThresholds(settings), [settings]);

  const chartData = useMemo(() => toChartPoints(daily), [daily]);

  const focusedStatus = (key: ParamKey): "good" | "warning" | "critical" => {
    if (!overview) return "good";
    return getThresholdStatus(overview.summary[key].avg, thresholds[key].range, thresholds[key].isMinOnly);
  };

  // Appends band series for the focused parameter so the safe range + limits
  // can be drawn with plain series (no ReferenceArea — recharts 3.8.1 hazard).
  const displayData = useMemo(() => {
    if (!focused) return chartData;
    const meta = PARAM_META[focused];
    const t = thresholds[focused];
    return chartData.map((d) => ({
      ...d,
      bandMin: t.range.min,
      bandMax: t.range.max,
      bandAxis: meta.yAxisId,
    }));
  }, [chartData, focused, thresholds]);

  // Rolling 7-day average for the focused parameter.
  const rollKey = focused ? `roll_${focused}` : null;
  const rollData = useMemo(() => {
    if (!focused) return [];
    const key = focused === "temperature" ? "temp" : focused === "water_level" ? "water" : "ammonia";
    const values = chartData.map((d) => d[key]);
    return rollingAvg(values, 7);
  }, [chartData, focused]);

  // Best/worst day highlights for the selected window.
  const dayHighlights = useMemo(() => {
    const valid = daily.filter((d) => Number(d.readings) > 0);
    if (valid.length === 0) return null;
    const num = (v: number) => Number(v) || 0;

    let hottest = valid[0], coldest = valid[0], highestAmmonia = valid[0], mostAlerts = valid[0], busiest = valid[0];
    for (const d of valid) {
      if (num(d.temp_avg) > num(hottest.temp_avg)) hottest = d;
      if (num(d.temp_avg) < num(coldest.temp_avg)) coldest = d;
      if (num(d.ammonia_avg) > num(highestAmmonia.ammonia_avg)) highestAmmonia = d;
      if (num(d.alerts) > num(mostAlerts.alerts)) mostAlerts = d;
      if (num(d.readings) > num(busiest.readings)) busiest = d;
    }
    return { hottest, coldest, highestAmmonia, mostAlerts, busiest };
  }, [daily]);

  // Days whose daily average fell below/above the configured safe range, per param.
  const safeBreachDays = useMemo(() => {
    const out: Record<ParamKey, { below: number; above: number }> = {
      temperature: { below: 0, above: 0 },
      water_level: { below: 0, above: 0 },
      ammonia: { below: 0, above: 0 },
    };
    const keyToAvg: Record<ParamKey, (d: AnalyticsDailyEntry) => number> = {
      temperature: (d) => Number(d.temp_avg),
      water_level: (d) => Number(d.water_avg),
      ammonia: (d) => Number(d.ammonia_avg),
    };
    for (const d of daily) {
      for (const key of Object.keys(out) as ParamKey[]) {
        const avg = keyToAvg[key](d);
        const t = thresholds[key];
        if (!Number.isFinite(avg) || !t) continue;
        if (avg < t.range.min) out[key].below += 1;
        else if (avg > t.range.max) out[key].above += 1;
      }
    }
    return out;
  }, [daily, thresholds]);

  // Days in the window that had at least one recorded alert.
  const alertDays = useMemo(
    () => daily.filter((d) => Number(d.alerts) > 0).length,
    [daily]
  );

  if (loading && !overview) {
    return <LoadingCard title="Analytics" message="Analyzing sensor data..." />;
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

  const alertParams = Object.entries(alerts.by_parameter);
  const avgDailyReadings = overview.days > 0 ? Math.round(uptime.readings / overview.days) : 0;
  const avgDailyAlerts = overview.days > 0 ? (alerts.total / overview.days).toFixed(1) : "0";

  type TooltipEntry = { dataKey?: unknown; color?: string; name?: string | number; value?: unknown };

const tooltipSeriesFilter = (payload: readonly TooltipEntry[]): TooltipEntry[] =>
  [...payload].filter((p) => !BAND_KEYS.includes(String(p.dataKey)));

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
                    ? "bg-orange-500 text-white shadow-sm"
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
            {loading && overview && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-600 px-2 py-1 rounded-full bg-orange-50">
                <RefreshCw size={12} className="animate-spin" />
                Updating…
              </span>
            )}
          </div>
        </div>

        <div className="mt-3 text-xs text-gray-400">
          Window: {formatFarmDate(overview.period.start)} – {formatFarmDate(overview.period.end)} · {overview.days} days
        </div>

        {/* Period mini-stats */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Database size={12} /> Total Readings
            </div>
            <div className="text-xl font-bold text-gray-800 mt-0.5">{uptime.readings.toLocaleString()}</div>
            <div className="text-[10px] text-gray-400">~{avgDailyReadings.toLocaleString()} / day</div>
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <BellRing size={12} /> Alerts
            </div>
            <div className="text-xl font-bold text-gray-800 mt-0.5">{alerts.total}</div>
            <div className="text-[10px] text-gray-400">~{avgDailyAlerts} / day</div>
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <CheckCircle2 size={12} /> Resolved
            </div>
            <div className="text-xl font-bold text-gray-800 mt-0.5">{alerts.resolved}</div>
            <div className="text-[10px] text-gray-400">
              {alerts.total > 0 ? `${Math.round((alerts.resolved / alerts.total) * 100)}% of alerts` : "no alerts"}
            </div>
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Activity size={12} /> Device
            </div>
            <div className={`text-xl font-bold mt-0.5 ${uptime.device_offline ? "text-red-600" : "text-emerald-600"}`}>
              {uptime.device_offline ? "Offline" : "Online"}
            </div>
            <div className="text-[10px] text-gray-400">Last data {formatAgo(uptime.last_reading)}</div>
          </div>
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
          status={focusedStatus("temperature")}
          safeRange={{ min: thresholds.temperature.range.min, max: thresholds.temperature.range.max }}
          breach={safeBreachDays.temperature}
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
          status={focusedStatus("water_level")}
          safeRange={{ min: thresholds.water_level.range.min, max: thresholds.water_level.range.max }}
          breach={safeBreachDays.water_level}
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
          status={focusedStatus("ammonia")}
          safeRange={{ min: thresholds.ammonia.range.min, max: thresholds.ammonia.range.max }}
          breach={safeBreachDays.ammonia}
        />
      </div>

      {/* Uptime + alerts details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-2">
            {uptime.device_offline ? (
              <WifiOff size={16} className="text-red-500" />
            ) : (
              <Activity size={16} className="text-green-500" />
            )}
            <span className="text-xs font-semibold uppercase tracking-wide">Device Status</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`font-bold text-xl ${uptime.device_offline ? "text-red-600" : "text-gray-800"}`}>
              {uptime.device_offline ? "Offline" : "Online"}
            </span>
            {!uptime.device_offline && uptime.last_reading && (
              <span className="text-xs text-emerald-600">{formatAgo(uptime.last_reading)}</span>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-2 space-y-0.5">
            <p className="flex items-center gap-1.5">
              <Database size={12} className="text-gray-400" /> {uptime.readings.toLocaleString()} readings in window
            </p>
            <p className="flex items-center gap-1.5">
              {uptime.device_offline ? <WifiOff size={12} className="text-red-400" /> : <Activity size={12} className="text-green-400" />}
              Last data: {uptime.last_reading ? formatFarmDateTime(uptime.last_reading) : "none"}
            </p>
            {uptime.gap_events > 0 ? (
              <p className="text-amber-600 flex items-center gap-1.5">
                <AlertTriangle size={12} /> {uptime.gap_events} connection gap(s) detected
              </p>
            ) : (
              <p className="text-green-600 flex items-center gap-1.5">
                <CheckCircle2 size={12} /> No connection gaps detected
              </p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-2">
            <AlertTriangle size={16} className="text-amber-500" />
            <span className="text-xs font-semibold uppercase tracking-wide">Alert Activity</span>
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
          {daily.length > 0 && (
            <p className="text-[11px] text-gray-400 mt-1">
              {alertDays > 0
                ? `${alertDays} of ${daily.length} day${daily.length === 1 ? "" : "s"} had at least one alert`
                : "No alert days in this window"}
            </p>
          )}
          {alertParams.length > 0 ? (
            <div className="flex flex-wrap gap-2 mt-2">
              {alertParams.map(([param, count]) => (
                <span key={param} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-100">
                  {SENSOR_KEY_TO_DISPLAY[param] ?? param}: {count}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400 mt-2">No alerts triggered in this period.</p>
          )}
        </div>
      </div>

      {/* Daily volume chart: readings + alerts per day */}
      {chartData.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <h2 className="text-lg font-bold text-gray-800 mb-4">Daily Readings &amp; Alerts</h2>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                tickFormatter={fmtAxisDate}
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
                allowDecimals={false}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm text-xs">
                      <p className="font-semibold text-gray-800 mb-1">{formatFarmDate(String(label))}</p>
                      {payload.map((p) => (
                        <p key={String(p.dataKey)} className="text-gray-600">
                          <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: p.color }} />
                          {p.name}: {p.value != null ? Number(p.value).toLocaleString() : "—"}
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar dataKey="readings" name="Readings" fill="#93c5fd" fillOpacity={0.7} maxBarSize={28} yAxisId="left" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="alerts" name="Alerts" fill="#fca5a5" fillOpacity={0.85} maxBarSize={28} yAxisId="right" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-2 flex flex-wrap justify-end gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-orange-300" /> Readings
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-red-300" /> Alerts
            </span>
          </div>
        </div>
      )}

      {/* Daily averages chart with focus + safe band + rolling average */}
      {chartData.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold text-gray-800">Daily Averages</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {focused ? "Safe band + 7-day rolling average shown for the focused parameter" : "Click a parameter to focus its safe range"}
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setFocused(null)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                  !focused ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                All
              </button>
              {(Object.keys(PARAM_META) as ParamKey[]).map((key) => (
                <button
                  key={key}
                  onClick={() => setFocused(key)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                    focused === key ? "text-white shadow-sm" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                  style={focused === key ? { backgroundColor: PARAM_META[key].color } : undefined}
                >
                  {PARAM_META[key].icon}
                  {PARAM_META[key].label}
                </button>
              ))}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={displayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                tickFormatter={fmtAxisDate}
                interval={Math.max(0, Math.floor(displayData.length / 10) - 1)}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
                width={42}
                yAxisId="left"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
                width={42}
                yAxisId="right"
                orientation="right"
              />
              {/* Hidden axis so Water Level (%) scales independently of Temperature (°C) */}
              <YAxis yAxisId="water" hide width={0} axisLine={false} tickLine={false} tick={false} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const real = tooltipSeriesFilter(payload);
                  const selected = daily.find((d) => d.date === label);
                  return (
                    <div className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm text-xs">
                      <p className="font-semibold text-gray-800 mb-1">{formatFarmDate(String(label))}</p>
                      {real.length === 0 && <p className="text-gray-400">—</p>}
                      {real.map((p) => (
                        <p key={String(p.dataKey)} className="text-gray-700">
                          <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: p.color }} />
                          {p.name}: {p.value != null ? Number(p.value).toFixed(2) : "—"}
                        </p>
                      ))}
                      {selected && (
                        <div className="mt-1 pt-1 border-t border-gray-100">
                          <p className="text-gray-400">{selected.readings.toLocaleString()} readings</p>
                          <p className="text-gray-700">Alerts: {selected.alerts}</p>
                        </div>
                      )}
                    </div>
                  );
                }}
              />

              {focused && (
                <>
                  <Area
                    dataKey="bandMax"
                    baseValue={thresholds[focused].range.min}
                    stroke="none"
                    fill="#10b981"
                    fillOpacity={0.08}
                    isAnimationActive={false}
                    activeDot={false}
                    yAxisId={PARAM_META[focused].yAxisId}
                  />
                  <Line
                    dataKey="bandMin"
                    stroke="#ef4444"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                    yAxisId={PARAM_META[focused].yAxisId}
                  />
                  <Line
                    dataKey="bandMax"
                    stroke="#ef4444"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                    yAxisId={PARAM_META[focused].yAxisId}
                  />
                </>
              )}

              {/* Rolling average only in focus mode */}
              {focused && rollData.length > 0 && (
                <Line
                  dataKey={rollKey as string}
                  name={`${PARAM_META[focused].label} (7d avg)`}
                  stroke="#6b7280"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                  yAxisId={PARAM_META[focused].yAxisId}
                />
              )}

              <Line
                type="monotone"
                dataKey="temp"
                name="Temperature (°C)"
                stroke={PARAM_META.temperature.color}
                strokeWidth={focused ? (focused === "temperature" ? 2.5 : 0) : 2}
                dot={false}
                connectNulls
                isAnimationActive={false}
                yAxisId="left"
                hide={focused !== null && focused !== "temperature"}
              />
              <Line
                type="monotone"
                dataKey="water"
                name="Water Level (%)"
                stroke={PARAM_META.water_level.color}
                strokeWidth={focused ? (focused === "water_level" ? 2.5 : 0) : 2}
                dot={false}
                connectNulls
                isAnimationActive={false}
                yAxisId="left"
                hide={focused !== null && focused !== "water_level"}
              />
              <Line
                type="monotone"
                dataKey="ammonia"
                name="Ammonia (ppm)"
                stroke={PARAM_META.ammonia.color}
                strokeWidth={focused ? (focused === "ammonia" ? 2.5 : 0) : 2}
                dot={false}
                connectNulls
                isAnimationActive={false}
                yAxisId="right"
                hide={focused !== null && focused !== "ammonia"}
              />
            </ComposedChart>
          </ResponsiveContainer>

          {dayHighlights && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
              <div className="rounded-lg bg-orange-50 border border-orange-100 p-2.5">
                <p className="flex items-center gap-1 text-[10px] text-orange-600 font-bold uppercase">
                  <Flame size={12} /> Hottest Day
                </p>
                <p className="text-sm font-bold text-gray-800">{Number(dayHighlights.hottest.temp_avg).toFixed(1)}°C</p>
                <p className="text-[10px] text-gray-400">{formatFarmDate(dayHighlights.hottest.date)}</p>
              </div>
              <div className="rounded-lg bg-amber-50 border border-amber-100 p-2.5">
                <p className="flex items-center gap-1 text-[10px] text-amber-600 font-bold uppercase">
                  <Snowflake size={12} /> Coolest Day
                </p>
                <p className="text-sm font-bold text-gray-800">{Number(dayHighlights.coldest.temp_avg).toFixed(1)}°C</p>
                <p className="text-[10px] text-gray-400">{formatFarmDate(dayHighlights.coldest.date)}</p>
              </div>
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2.5">
                <p className="flex items-center gap-1 text-[10px] text-emerald-600 font-bold uppercase">
                  <FlaskConical size={12} /> Peak Ammonia
                </p>
                <p className="text-sm font-bold text-gray-800">{Number(dayHighlights.highestAmmonia.ammonia_avg).toFixed(2)} ppm</p>
                <p className="text-[10px] text-gray-400">{formatFarmDate(dayHighlights.highestAmmonia.date)}</p>
              </div>
              <div className="rounded-lg bg-red-50 border border-red-100 p-2.5">
                <p className="flex items-center gap-1 text-[10px] text-red-600 font-bold uppercase">
                  <BellRing size={12} /> Most Alerts
                </p>
                <p className="text-sm font-bold text-gray-800">{Number(dayHighlights.mostAlerts.alerts)}</p>
                <p className="text-[10px] text-gray-400">{formatFarmDate(dayHighlights.mostAlerts.date)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 border border-gray-100 p-2.5">
                <p className="flex items-center gap-1 text-[10px] text-gray-600 font-bold uppercase">
                  <Database size={12} /> Busiest Day
                </p>
                <p className="text-sm font-bold text-gray-800">{Number(dayHighlights.busiest.readings).toLocaleString()} reads</p>
                <p className="text-[10px] text-gray-400">{formatFarmDate(dayHighlights.busiest.date)}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {chartData.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <BarChart3 size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-600 font-medium">No daily data for this window</p>
          <p className="text-sm text-gray-400 mt-1">Try a wider range (30 or 90 days).</p>
        </div>
      )}

      {/* Suggestions panel */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Lightbulb size={20} className="text-amber-500" />
            Suggestions
          </h2>
          {(bySeverity("critical").length + bySeverity("warning").length + bySeverity("info").length) > 0 && (
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                {bySeverity("critical").length} critical
              </span>
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                {bySeverity("warning").length} warning
              </span>
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                {bySeverity("info").length} info
              </span>
            </div>
          )}
        </div>

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
    </div>
  );
}