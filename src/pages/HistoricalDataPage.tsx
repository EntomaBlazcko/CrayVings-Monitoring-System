import { useState, useMemo, useEffect, useCallback, createElement } from "react";
import {
  History,
  Thermometer,
  Waves,
  FlaskConical,
  Filter,
  TrendingUp,
  TrendingDown,
  Activity,
  Calendar,
  Download,
  AlertTriangle,
  Clock,
  Zap,
  Gauge,
} from "lucide-react";
import TrendCard from "../components/TrendCard";
import { ErrorCard } from "../components/Loading";
import TankSelector from "../components/TankSelector";
import { useSensors } from "../hooks/useSensors";
import { useAuth } from "../contexts/useAuth";
import { fmtStat } from "../utils/text";
import { fetchSensorHistory, fetchSensorHistoryWindow, fetchRangeReport } from "../api/client";
import { isAxiosError } from "axios";
import { getSettingsThresholds, getThresholdStatus, type ThresholdStatus } from "../types";
import type { ChartPoint, WeeklyReport } from "../types";
import { formatFarmTime, formatFarmDate, formatFarmDateTime, farmDateToStart, farmDateToEndExclusive, farmDateInputValue } from "../utils/time";
import { SENSOR_COLORS, BAND_COLORS, hexToRgb } from "../utils/tokens";
import {
  PDF,
  BRAND_NAME,
  BRAND_TAGLINE,
  fill,
  text,
  stroke,
  drawHeaderBand as brandDrawHeaderBand,
  drawSlimHeader as brandDrawSlimHeader,
  drawFooter as brandDrawFooter,
  drawLogo,
  loadLogoDataUrl,
} from "../utils/pdfBrand";
import brandLogo from "../assets/crayvings.png";

// Detects AbortError from AbortController cancellation (native fetch or axios).
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "AbortError";
  return isAxiosError(err) && (err.code === "ERR_CANCELED" || err.name === "CanceledError");
}

type TimeRange = "1h" | "6h" | "24h" | "1w" | "all" | "custom";
type SensorKey = "temperature" | "water_level" | "ammonia";

// Preset windows are fixed lengths; "custom" is deliberately not a key because
// its bounds come from the date picker, not a length. Keeping it out of the map
// makes RANGE_WINDOW_MS[range] type-safe once "custom" has been excluded.
type PresetRange = Exclude<TimeRange, "custom">;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Window length per preset; null = "everything up to the anchor" (All Time).
const RANGE_WINDOW_MS: Record<PresetRange, number | null> = {
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "24h": DAY_MS,
  "1w": 7 * DAY_MS,
  all: null,
};

// Safety cap on rows returned in a window, not a paging mechanism: ?from/?to
// bounds the result, so this only stops pathological data. Must not exceed
// MAX_SENSOR_HISTORY_ROWS in server.cjs or the server silently truncates.
const HISTORY_FETCH_LIMIT = 20000;

const SENSOR_KEYS: SensorKey[] = ["temperature", "water_level", "ammonia"];

const PARAM_META: { label: string; icon: typeof Thermometer; tint: string; stroke: string; unit: string; decimals: number }[] = [
  { label: "Temperature", icon: Thermometer, tint: "text-orange-500", stroke: SENSOR_COLORS.temperature, unit: "°C", decimals: 1 },
  { label: "Water Level", icon: Waves, tint: "text-blue-500", stroke: SENSOR_COLORS.water_level, unit: "%", decimals: 0 },
  { label: "Ammonia", icon: FlaskConical, tint: "text-emerald-500", stroke: SENSOR_COLORS.ammonia, unit: "ppm", decimals: 2 },
];

const STATUS_PILL: Record<ThresholdStatus, string> = {
  good: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  critical: "bg-red-100 text-red-700",
};

const STATUS_TEXT: Record<ThresholdStatus, string> = {
  good: "text-emerald-600",
  warning: "text-amber-600",
  critical: "text-red-600",
};

const STATUS_DOT: Record<ThresholdStatus, string> = {
  good: "bg-emerald-500",
  warning: "bg-amber-500",
  critical: "bg-red-500",
};

// Calculates min/max/avg stats for each sensor parameter from chart data.
function getStats(data: ChartPoint[]) {
  if (!data || data.length === 0) return null;

  const calc = (key: SensorKey) => {
    const values = data
      .map(d => d[key])
      .filter((v): v is number => typeof v === "number" && !isNaN(v));
    if (values.length === 0) return null;
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    };
  };

  return {
    temperature: calc("temperature"),
    water_level: calc("water_level"),
    ammonia: calc("ammonia"),
  };
}

// Downsamples long series (1w / all ranges) so charts stay responsive.
function decimate(data: ChartPoint[], maxPoints: number): ChartPoint[] {
  if (data.length <= maxPoints) return data;
  const step = Math.ceil(data.length / maxPoints);
  const sampled: ChartPoint[] = [];
  for (let i = 0; i < data.length; i += step) sampled.push(data[i]);
  if (sampled[sampled.length - 1] !== data[data.length - 1]) sampled.push(data[data.length - 1]);
  return sampled;
}

// Report bucket labels are farm wall-clock time with no offset attached
// ("2026-08-25T08:00" for an hourly bucket, "2026-08-25" for a daily one). Pin
// the +08:00 the farm runs on, otherwise an hour label is parsed in the viewer's
// own timezone and can render hours off. Plain dates are safe as-is: a date-only
// ISO string is always parsed as UTC midnight, the same calendar day once the
// farm's +08:00 is applied.
function bucketInstant(label: string): string {
  return /T\d{2}:\d{2}$/.test(label) ? `${label}:00+08:00` : label;
}

// Trailing moving average per point (window of the last N valid values).
function trailingAverage(data: ChartPoint[], key: SensorKey, window: number): (number | null)[] {
  return data.map((_, i) => {
    const lo = Math.max(0, i - window + 1);
    const slice = data
      .slice(lo, i + 1)
      .map((p) => p[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
  });
}

// Compares the first half of the window against the last half to detect trend.
function segmentTrend(data: ChartPoint[], key: SensorKey): "up" | "down" | "stable" | null {
  const values = data
    .map((p) => p[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (values.length < 8) return null;
  const half = Math.floor(values.length / 2);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const first = avg(values.slice(0, half));
  const last = avg(values.slice(values.length - half, values.length));
  const pctChange = Math.abs(last - first) / (Math.abs(first) || 1) * 100;
  if (pctChange < 1) return "stable";
  return last > first ? "up" : "down";
}

// Builds plain-language recommendations for the exported PDF by comparing the
// report's period averages/alerts against the configured safe thresholds.
function buildReportSuggestions(
  report: WeeklyReport,
  thresholds: ReturnType<typeof getSettingsThresholds>
): string[] {
  const lines: string[] = [];
  const s = report.summary;
  const alerts = report.alerts;

  const temp = thresholds.temperature;
  if (temp && s.temp_avg != null && (s.temp_avg < temp.range.min || s.temp_avg > temp.range.max)) {
    lines.push(
      `Temperature averaged ${s.temp_avg.toFixed(1)}°C, outside the configured safe range ` +
        `(${temp.range.min}-${temp.range.max}°C). Check the heater, ventilation and probe placement.`
    );
  } else if (s.temp_avg != null) {
    lines.push(`Temperature stayed within the configured safe range (avg ${s.temp_avg.toFixed(1)}°C).`);
  }

  const water = thresholds.water_level;
  if (water && s.water_avg != null && (s.water_avg < water.range.min || s.water_avg > water.range.max)) {
    lines.push(
      `Water level averaged ${s.water_avg.toFixed(0)}%, outside the configured safe range ` +
        `(${water.range.min}-${water.range.max}%). Inspect for leaks, pump issues or overflow.`
    );
  }

  const ammonia = thresholds.ammonia;
  if (ammonia && s.ammonia_avg != null && s.ammonia_avg > ammonia.range.max) {
    lines.push(
      `Ammonia averaged ${s.ammonia_avg.toFixed(2)} ppm, above the configured ceiling ` +
        `(${ammonia.range.max} ppm). Do a partial water change, reduce feeding and check the biofilter.`
    );
  }

  if (alerts.total > 0) {
    lines.push(
      `${alerts.total} alert(s) fired in this period. Review the Alerts page and acknowledge each one ` +
        `so unresolved issues stay visible.`
    );
  } else {
    lines.push("No alerts were recorded — conditions stayed calm throughout the period.");
  }

  return lines;
}

export default function HistoricalDataPage() {
  const { history, loading, connectionStatus, lastUpdate, historyStale, historyLastUpdated, settingsFor, selectedDeviceId } = useSensors();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [showMovingAverage, setShowMovingAverage] = useState(true);
  const [dynamicHistory, setDynamicHistory] = useState<ChartPoint[]>([]);
  const [dynamicLoading, setDynamicLoading] = useState(false);
  const [historyFetchError, setHistoryFetchError] = useState<string | null>(null);
  const [rangeReport, setRangeReport] = useState<WeeklyReport | null>(null);
  const [rangeReportLoading, setRangeReportLoading] = useState(false);
  const [rangeReportError, setRangeReportError] = useState<string | null>(null);
  const [rangeRetry, setRangeRetry] = useState(0);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [exportingPdf, setExportingPdf] = useState(false);

  // Custom-range draft (what the two date inputs currently hold, as farm dates)
  // and the committed window. Kept apart so typing a half-finished date never
  // fires a fetch: nothing is queried until the user presses Apply.
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [appliedCustom, setAppliedCustom] = useState<{ from: string; to: string } | null>(null);

  const timeRanges: { value: TimeRange; label: string }[] = [
    { value: "1h", label: "1 Hour" },
    { value: "6h", label: "6 Hours" },
    { value: "24h", label: "24 Hours" },
    { value: "1w", label: "1 Week" },
    { value: "all", label: "All Time" },
    { value: "custom", label: "Custom" },
  ];

  // Always fetches from server (DB), so it works offline. Provider history is only seed.
  // Scoped to the currently selected tank so each chart reflects one device.
  //
  // Two requests on purpose: the first finds the newest reading (the anchor, not
  // the wall clock - see dataAnchorMs below), the second pulls exactly that
  // range's window. Asking for "newest N rows" instead meant a week of 5-minute
  // readings (2016 rows) was cut off at 1000, so 1 Week/All Time only ever drew
  // the last ~3.5 days.
  const fetchDynamicData = useCallback(async (range: TimeRange, signal: AbortSignal) => {
    // A custom range names both bounds already, so skip the anchor probe and ask
    // for exactly the chosen days. /sensor's ?to is inclusive while the window
    // is [start, end), so send one ms below the exclusive end.
    if (range === "custom") {
      const start = farmDateToStart(appliedCustom?.from);
      const end = farmDateToEndExclusive(appliedCustom?.to);
      if (!start || !end) return [];
      return fetchSensorHistoryWindow(
        selectedDeviceId,
        start.toISOString(),
        new Date(end.getTime() - 1).toISOString(),
        HISTORY_FETCH_LIMIT,
        signal,
      );
    }

    const anchorRows = await fetchSensorHistory(1, selectedDeviceId, signal);
    const newest = anchorRows.length > 0
      ? new Date(anchorRows[anchorRows.length - 1].timestamp).getTime()
      : Date.now();
    const windowMs = RANGE_WINDOW_MS[range];
    const fromIso = windowMs === null ? null : new Date(newest - windowMs).toISOString();
    const toIso = new Date(newest).toISOString();
    return fetchSensorHistoryWindow(selectedDeviceId, fromIso, toIso, HISTORY_FETCH_LIMIT, signal);
  }, [selectedDeviceId, appliedCustom]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDynamicLoading(true);

    fetchDynamicData(timeRange, controller.signal)
      .then(data => {
        setDynamicHistory(data);
        setHistoryFetchError(null);
        setDynamicLoading(false);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) {
          setHistoryFetchError((err as Error)?.message || 'Failed to load historical data');
        }
        setDynamicLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [timeRange, fetchDynamicData, historyRetry]);

  const activeHistory = dynamicHistory.length > 0 ? dynamicHistory : history;
  const activeLoading = dynamicLoading || loading;

  // Anchor for every "last N" window on this page: the newest reading we
  // actually have, not the wall clock. A tank that stopped reporting weeks ago
  // still has a usable "1 Week"/"24 Hours" window - its final week - instead of
  // every range computing against now and coming back empty.
  //
  // Deliberately NOT lastUpdate: the provider derives that from recv_at, i.e.
  // devices.last_seen (when the server last heard from the board), which can be
  // far newer than the stored reading. ESP32_01's last_seen was Oct 16 while its
  // newest row was Sep 1, so including it pushed the window into an empty week
  // and every chart/PDF came back blank.
  const dataAnchorMs = useMemo(() => {
    let newest = 0;
    for (const p of activeHistory) {
      const t = p.timestamp ? new Date(p.timestamp).getTime() : 0;
      if (t > newest) newest = t;
    }
    return newest > 0 ? newest : Date.now();
  }, [activeHistory]);

  // Window end used by the presets, quantized to the hour. dataAnchorMs advances
  // with every live reading and the report endpoint is a multi-query round trip,
  // so quantizing caps that refetch at once an hour. Ceil (not floor) guarantees
  // the window never ends before the newest point, so the report and the PDF can
  // never be missing the tail of what the chart shows.
  const reportEndMs = useMemo(
    () => Math.ceil(dataAnchorMs / HOUR_MS) * HOUR_MS,
    [dataAnchorMs],
  );

  // The one window every part of this page agrees on, as [startMs, endMs):
  //   preset   -> a fixed length ending at the hour the newest reading falls in
  //   All Time -> open start (null), same end
  //   custom   -> the two farm days the user picked; the end is the next
  //               midnight, so the final day is included without a 23:59:59 fudge
  // A null result means the custom dates are not (yet) a valid range, which
  // renders the empty state instead of silently guessing a window.
  const rangeWindow = useMemo<{ startMs: number | null; endMs: number } | null>(() => {
    if (timeRange === "custom") {
      const start = farmDateToStart(appliedCustom?.from);
      const end = farmDateToEndExclusive(appliedCustom?.to);
      if (!start || !end || start.getTime() >= end.getTime()) return null;
      return { startMs: start.getTime(), endMs: end.getTime() };
    }
    const windowMs = RANGE_WINDOW_MS[timeRange];
    return {
      startMs: windowMs === null ? null : reportEndMs - windowMs,
      endMs: reportEndMs,
    };
  }, [timeRange, appliedCustom, reportEndMs]);

  // Human label for the resolved window. Times alone only when the whole span
  // fits inside one day, since "8:00 AM -> 7:55 AM" reads as if it ran backwards
  // once it crosses midnight. endMs is exclusive, so show the last instant in it.
  const rangeLabel = useMemo(() => {
    if (!rangeWindow) return null;
    const { startMs, endMs } = rangeWindow;
    const short = startMs !== null && endMs - startMs < DAY_MS;
    const fmt = short ? formatFarmTime : formatFarmDate;
    const startLabel = startMs === null ? "earliest" : fmt(new Date(startMs));
    const endLabel = fmt(new Date(endMs - 1));
    return `${startLabel} → ${endLabel}`;
  }, [rangeWindow]);

  // One report for the resolved window feeds the on-screen breakdown, the alert
  // summary and the PDF, so all three describe exactly what the charts show. It
  // waits for the first history load so the window ends on a real reading rather
  // than the Date.now() fallback, which would fetch an empty week and never refetch.
  useEffect(() => {
    // Reports are admin-gated server-side, so non-admins skip the fetch entirely
    // rather than collecting a 403 banner on every range. That also leaves the
    // breakdown and alert summary hidden for them, exactly as when only 1 Week
    // fetched a report.
    if (!isAdmin) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRangeReport(null);
      setRangeReportError(null);
      return;
    }
    if (dynamicLoading) return;
    if (!rangeWindow) {
      setRangeReport(null);
      setRangeReportError(null);
      return;
    }

    const controller = new AbortController();
    setRangeReportLoading(true);
    setRangeReportError(null);

    // Scoped to the selected tank so the table + PDF match the on-screen charts.
    fetchRangeReport({
      deviceId: selectedDeviceId,
      signal: controller.signal,
      fromIso: rangeWindow.startMs !== null ? new Date(rangeWindow.startMs).toISOString() : null,
      toIso: new Date(rangeWindow.endMs).toISOString(),
    })
      .then(data => {
        setRangeReport(data);
        setRangeReportLoading(false);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) {
          setRangeReportError((err as Error)?.message || 'Failed to load the period report');
          setRangeReportLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [rangeWindow, selectedDeviceId, rangeRetry, dynamicLoading, isAdmin]);

  // Custom-range draft validity, recomputed each render (two cheap string parses).
  const customStart = farmDateToStart(customFrom);
  const customEnd = farmDateToEndExclusive(customTo);
  const customValid = !!customStart && !!customEnd && customStart.getTime() < customEnd.getTime();

  const selectRange = (range: TimeRange) => {
    if (range !== "custom") {
      setTimeRange(range);
      return;
    }
    // Open the picker on a week of real data the first time (or after a reset);
    // later clicks keep whatever the user last chose.
    const fallbackFrom = farmDateInputValue(reportEndMs - 7 * DAY_MS);
    const fallbackTo = farmDateInputValue(reportEndMs);
    const from = customFrom || fallbackFrom;
    const to = customTo || fallbackTo;
    setCustomFrom(from);
    setCustomTo(to);
    setAppliedCustom(prev => prev ?? { from, to });
    setTimeRange("custom");
  };

  const applyCustomRange = () => {
    if (!customValid) return;
    setAppliedCustom({ from: customFrom, to: customTo });
    setTimeRange("custom");
  };

  // Range buttons are never disabled. A range with no readings shows the
  // empty-state message and explains why, which is more useful than a greyed-out
  // button the user cannot press - and disabling used to lock out every range
  // for an offline tank even when its history covered them.

  const filteredHistory = useMemo(() => {
    if (!activeHistory || activeHistory.length === 0) return [];
    // A custom range with incomplete dates has no window; show nothing rather
    // than silently falling back to the whole history.
    if (!rangeWindow) return [];

    const { startMs, endMs } = rangeWindow;
    const sorted = [...activeHistory].sort((a, b) => {
      const ta = new Date(a.timestamp || 0).getTime();
      const tb = new Date(b.timestamp || 0).getTime();
      return ta - tb;
    });

    return sorted.filter((item) => {
      if (!item.timestamp) return false;
      const t = new Date(item.timestamp).getTime();
      return (startMs === null || t >= startMs) && t < endMs;
    });
  }, [activeHistory, rangeWindow]);

  const stats = useMemo(() => getStats(filteredHistory), [filteredHistory]);

  const latestReading = useMemo(() => {
    if (filteredHistory.length > 0) return filteredHistory[filteredHistory.length - 1];
    if (activeHistory && activeHistory.length > 0) {
      const sorted = [...activeHistory].sort((a, b) => {
        const ta = new Date(a.timestamp || 0).getTime();
        const tb = new Date(b.timestamp || 0).getTime();
        return ta - tb;
      });
      return sorted[sorted.length - 1];
    }
    return null;
  }, [filteredHistory, activeHistory]);

  // The SELECTED tank's effective thresholds (global defaults + per-tank
  // override) — the history being charted is already scoped to that tank.
  const thresholds = useMemo(
    () => getSettingsThresholds(settingsFor(selectedDeviceId)),
    [settingsFor, selectedDeviceId]
  );

  // Safe/warning/critical status of the most recent reading per parameter.
  const latestStatuses = useMemo(() => {
    const out: Partial<Record<SensorKey, ThresholdStatus>> = {};
    if (!latestReading) return out;
    for (const key of SENSOR_KEYS) {
      const value = latestReading[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        const t = thresholds[key];
        out[key] = getThresholdStatus(value, t.range, t.isMinOnly);
      }
    }
    return out;
  }, [latestReading, thresholds]);

  // How many readings in the selected window fell outside the safe band.
  const breachCounts = useMemo(() => {
    const counts: Record<SensorKey, number> = { temperature: 0, water_level: 0, ammonia: 0 };
    if (filteredHistory.length === 0) return counts;
    for (const item of filteredHistory) {
      for (const key of SENSOR_KEYS) {
        const value = item[key];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const t = thresholds[key];
        if (getThresholdStatus(value, t.range, t.isMinOnly) !== "good") counts[key] += 1;
      }
    }
    return counts;
  }, [filteredHistory, thresholds]);

  // First-half vs last-half trend for each parameter within the window.
  const trends = useMemo(() => {
    const out: Partial<Record<SensorKey, "up" | "down" | "stable">> = {};
    for (const key of SENSOR_KEYS) {
      const trend = segmentTrend(filteredHistory, key);
      if (trend) out[key] = trend;
    }
    return out;
  }, [filteredHistory]);

  // Highest / lowest reading per parameter with the time it occurred.
  const windowHighlights = useMemo(() => {
    const out: Record<SensorKey, { peak: { value: number; time: string } | null; low: { value: number; time: string } | null }> = {
      temperature: { peak: null, low: null },
      water_level: { peak: null, low: null },
      ammonia: { peak: null, low: null },
    };
    for (const item of filteredHistory) {
      for (const key of SENSOR_KEYS) {
        const v = item[key];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const time = item.timestamp ?? "";
        const entry = { value: v, time };
        const cur = out[key];
        if (!cur.peak || v > cur.peak.value) cur.peak = entry;
        if (!cur.low || v < cur.low.value) cur.low = entry;
      }
    }
    return out;
  }, [filteredHistory]);

  // Estimation of expected readings (sensors report ~1/min) for coverage %.
  // Open-ended (All Time) has no expected count; everything else derives it from
  // the resolved window's span, so a custom week gets the same measure a preset does.
  const expectedReadings = useMemo(() => {
    if (!rangeWindow || rangeWindow.startMs === null) return null;
    return Math.round(((rangeWindow.endMs - rangeWindow.startMs) / HOUR_MS) * 60);
  }, [rangeWindow]);

  const coveragePct =
    expectedReadings && filteredHistory.length > 0
      ? Math.min(100, Math.round((filteredHistory.length / expectedReadings) * 100))
      : null;

  // Decimated chart series + optional moving-average overlay series.
  const chartHistory = useMemo(() => {
    const base = decimate(filteredHistory, 300);
    const temp = trailingAverage(base, "temperature", 7);
    const water = trailingAverage(base, "water_level", 7);
    const ammonia = trailingAverage(base, "ammonia", 7);
    return base.map((p, i) => ({
      ...p,
      _tempAvg: temp[i],
      _waterAvg: water[i],
      _ammoniaAvg: ammonia[i],
    }));
  }, [filteredHistory]);

  const handleExportPdf = useCallback(async () => {
    if (exportingPdf) return;

    // Popup blockers only allow window.open during the click's synchronous
    // stack, but building the PDF needs awaits (report fetch, jsPDF import).
    // Open the blank preview now and point it at the blob once it exists; if
    // the browser refused, fall back to a normal download so the export still
    // completes instead of silently doing nothing.
    const preview = window.open("", "_blank");
    if (preview) preview.opener = null;

    // Prefer the report already on screen; only refetch if it hasn't landed yet.
    let report = rangeReport;
    if (!report) {
      if (!rangeWindow) {
        preview?.close();
        alert("Choose a valid date range first.");
        return;
      }
      try {
        setExportingPdf(true);
        // Same window as the charts and the on-screen table, so the PDF can never
        // disagree with what is on screen.
        report = await fetchRangeReport({
          deviceId: selectedDeviceId,
          fromIso: rangeWindow.startMs !== null ? new Date(rangeWindow.startMs).toISOString() : null,
          toIso: new Date(rangeWindow.endMs).toISOString(),
        });
      } catch {
        preview?.close();
        alert("Failed to fetch report data.");
        setExportingPdf(false);
        return;
      }
    }

    try {
      // Lazy-load jspdf (~150kB+) only when user actually exports.
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);

      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();

      // ---- Design tokens (mirrors the dashboard's warm orange brand palette) ----
      // jsPDF cannot resolve var(), so the CSS-side tokens are converted to
      // numeric triplets by pdfBrand. Names and call sites are unchanged.
      const {
        ink: INK, gray: GRAY, white: WHITE, brand: BRAND, amber: AMBER,
        cardFill: CARD_FILL, cardLine: CARD_LINE, zebra: ZEBRA, line: LINE,
        onBrand: ON_BRAND, critical: CRITICAL,
        tableZebra: TABLE_ROW, noteFill: NOTE_FILL, noteLine: NOTE_LINE,
        alertFill: ALERT_FILL, alertFillOk: ALERT_FILL_OK,
        alertLine: ALERT_LINE, alertLineOk: ALERT_LINE_OK,
        gradMid: BRAND_MID,
      } = PDF;
      const PARAM: Record<string, number[]> = {
        temperature: hexToRgb(SENSOR_COLORS.temperature),
        water_level: hexToRgb(SENSOR_COLORS.water_level),
        ammonia: hexToRgb(SENSOR_COLORS.ammonia),
      };

      const margin = 12;
      const contentW = pageWidth - margin * 2;

      const setFill = (c: number[]) => fill(doc, c);
      const setText = (c: number[]) => text(doc, c);
      const setStroke = (c: number[]) => stroke(doc, c);

      // A 7-day window keeps the familiar "Weekly Report" title (the 1 Week
      // preset and any custom week alike); every other span is a history report.
      const periodDays = Math.round(
        (new Date(report.period.end).getTime() - new Date(report.period.start).getTime()) / DAY_MS
      );
      const documentLabel = periodDays === 7 ? "Weekly Report" : "History Report";

      // Slim branded strip reused on every page after the first.
      const drawSlimHeader = () => {
        brandDrawSlimHeader(doc, pageWidth, margin, documentLabel);
      };

      const drawFooter = (pageNumber: number) => {
        brandDrawFooter(doc, pageWidth, pageHeight, margin, pageNumber, formatFarmDate(new Date()));
      };

      const drawSectionTitle = (text: string, y: number): number => {
        setFill(BRAND);
        doc.roundedRect(margin, y - 3.4, 3.6, 6.8, 0.9, 0.9, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10.5);
        setText(INK);
        doc.text(text, margin + 8, y);
        return y + 6.5;
      };

      const addBrandedPage = (): number => {
        doc.addPage();
        const p = doc.getNumberOfPages();
        drawSlimHeader();
        drawFooter(p);
        return p;
      };

      const fmtPeriod = report.bucket === "hour" ? formatFarmDateTime : formatFarmDate;
      const startDate = fmtPeriod(report.period.start);
      const endDate = fmtPeriod(report.period.end);
      const title = `${BRAND_NAME} ${documentLabel}`;

      // ---- Header band ----
      const bandH = 52;
      brandDrawHeaderBand(doc, pageWidth, bandH);
      setFill(AMBER);
      doc.rect(0, bandH, pageWidth, 2.2, "F");
      const logoData = await loadLogoDataUrl(brandLogo);
      if (logoData) drawLogo(doc, logoData, margin, 6, 30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      setText(WHITE);
      doc.text(title, pageWidth / 2, 20, { align: "center" });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.text(BRAND_TAGLINE, pageWidth / 2, 30, { align: "center" });
      doc.text(`Period: ${startDate} - ${endDate}`, pageWidth / 2, 40, { align: "center" });
      doc.setFontSize(7.5);
      setText(ON_BRAND);
      doc.text(`Generated on ${formatFarmDateTime(new Date())}`, pageWidth / 2, 48, { align: "center" });

      const summary = report.summary;

      // ---- Summary cards (one per monitored parameter) ----
      const cardY = 64;
      const cardH = 46;
      const gap = 6;
      const cardW = (contentW - gap * 2) / 3;
      const cards: { label: string; color: number[]; avg: string; minmax: string }[] = [
        {
          label: "Temperature",
          color: PARAM.temperature,
          avg: `${fmtStat(summary.temp_avg, 1)}°C`,
          minmax: `Min ${fmtStat(summary.temp_min, 1)} · Max ${fmtStat(summary.temp_max, 1)}`,
        },
        {
          label: "Water Level",
          color: PARAM.water_level,
          avg: `${fmtStat(summary.water_avg, 0)}%`,
          minmax: `Min ${fmtStat(summary.water_min, 0)} · Max ${fmtStat(summary.water_max, 0)}`,
        },
        {
          label: "Ammonia",
          color: PARAM.ammonia,
          avg: `${fmtStat(summary.ammonia_avg, 2)} ppm`,
          minmax: `Min ${fmtStat(summary.ammonia_min, 2)} · Max ${fmtStat(summary.ammonia_max, 2)}`,
        },
      ];
      cards.forEach((c, i) => {
        const x = margin + i * (cardW + gap);
        setFill(CARD_FILL);
        setStroke(CARD_LINE);
        doc.setLineWidth(0.5);
        doc.roundedRect(x, cardY, cardW, cardH, 3.5, 3.5, "FD");
        setFill(c.color);
        doc.roundedRect(x, cardY + 8, 3, cardH - 16, 1, 1, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.5);
        setText(c.color);
        doc.text(c.label.toUpperCase(), x + 8.5, cardY + 13);
        doc.setFontSize(14);
        setText(INK);
        doc.text(c.avg, x + 8.5, cardY + 30);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6.8);
        setText(GRAY);
        doc.text(c.minmax, x + 8.5, cardY + 41);
      });

      // ---- Totals chips ----
      const chipY = cardY + cardH + 9;
      const chipH = 22;
      const chipW = (contentW - gap) / 2;
      const totals: { label: string; value: string; valueColor: number[] }[] = [
        { label: "Total Readings", value: (summary.total_readings ?? 0).toLocaleString(), valueColor: INK },
        {
          label: "Total Alerts",
          value: String(report.alerts.total ?? 0),
          valueColor: (report.alerts.total ?? 0) > 0 ? CRITICAL : hexToRgb(BAND_COLORS.safe),
        },
      ];
      totals.forEach((t, i) => {
        const x = margin + i * (chipW + gap);
        setFill(TABLE_ROW);
        setStroke(LINE);
        doc.setLineWidth(0.4);
        doc.roundedRect(x, chipY, chipW, chipH, 3, 3, "FD");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(6.8);
        setText(GRAY);
        doc.text(t.label.toUpperCase(), x + 10, chipY + 9);
        doc.setFontSize(11.5);
        setText(t.valueColor);
        doc.text(t.value, x + 10, chipY + 17.5);
      });

      const tableStartY = chipY + chipH + 10;

      // Every export is now a bounded-window report (the 1 Week preset included),
      // so keep the table compact: smaller font, capped rows and an inline alert
      // panel, so long windows (e.g. "All Time") fit on 1-2 pages.
      const cappedBuckets = report.daily.slice(-60);
      const capNote =
        report.daily.length > cappedBuckets.length
          ? `Showing the last ${cappedBuckets.length} ${report.bucket === "hour" ? "hourly" : "daily"} buckets - the summary above covers the full period.`
          : null;
      const unitLabel = report.bucket === "hour" ? "Hour" : "Date";
      const fmtBucket = (label: string) =>
        report.bucket === "hour" ? formatFarmDateTime(bucketInstant(label)) : formatFarmDate(label);

      autoTable(doc, {
        startY: tableStartY,
        head: [[unitLabel, "Temp Avg", "Temp Range", "Water Avg", "Water Range", "Ammonia Avg", "Ammonia Range", "Readings", "Alerts"]],
        body: cappedBuckets.map(d => [
          fmtBucket(d.date),
          `${fmtStat(d.temp_avg, 1)}°C`,
          `${fmtStat(d.temp_min, 1)} - ${fmtStat(d.temp_max, 1)}°C`,
          `${fmtStat(d.water_avg, 0)}%`,
          `${fmtStat(d.water_min, 0)} - ${fmtStat(d.water_max, 0)}%`,
          `${fmtStat(d.ammonia_avg, 2)} ppm`,
          `${fmtStat(d.ammonia_min, 2)} - ${fmtStat(d.ammonia_max, 2)} ppm`,
          (d.readings ?? 0).toLocaleString(),
          String(d.alerts ?? 0),
        ]),
        theme: "grid",
        styles: {
          fontSize: 7.2,
          cellPadding: 1.7,
          valign: "middle",
          textColor: INK as [number, number, number],
          lineColor: LINE as [number, number, number],
          lineWidth: 0.25,
        },
        headStyles: {
          fillColor: BRAND as [number, number, number],
          textColor: WHITE as [number, number, number],
          fontStyle: "bold",
          halign: "center",
          fontSize: 7.6,
        },
        alternateRowStyles: { fillColor: ZEBRA as [number, number, number] },
        columnStyles: {
          0: { cellWidth: 46, halign: "left" },
          1: { halign: "center" },
          2: { halign: "center" },
          3: { halign: "center" },
          4: { halign: "center" },
          5: { halign: "center" },
          6: { halign: "center" },
          7: { halign: "center" },
          8: { halign: "center" },
        },
        margin: { left: margin, right: margin },
        didDrawPage: ({ pageNumber }) => {
          drawFooter(pageNumber);
          if (pageNumber > 1) drawSlimHeader();
        },
      });

      let afterTableY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? tableStartY + 10;

      if (capNote) {
        const boxY = afterTableY + 5;
        const noteH = 12;
        setFill(NOTE_FILL);
        setStroke(NOTE_LINE);
        doc.setLineWidth(0.4);
        doc.roundedRect(margin, boxY, contentW, noteH, 2.5, 2.5, "FD");
        doc.setFont("helvetica", "italic");
        doc.setFontSize(7);
        setText(GRAY);
        doc.text(capNote, margin + 6, boxY + 8);
        afterTableY = boxY + noteH + 4;
      } else {
        afterTableY += 3;
      }

      const hasAlerts =
        Object.keys(report.alerts.by_parameter).length > 0 || Object.keys(report.alerts.by_action).length > 0;
      let currentY = afterTableY;

      // ---- Alert panel ----
      const alertLines: { text: string; kind: "head" | "sub" | "item" }[] = [];
      alertLines.push({ text: `Total Alerts: ${report.alerts.total ?? 0}`, kind: "head" });
      const byParam = Object.entries(report.alerts.by_parameter);
      const byAction = Object.entries(report.alerts.by_action);
      if (byParam.length > 0) {
        alertLines.push({ text: "By Parameter", kind: "sub" });
        byParam.forEach(([p, c]) => alertLines.push({ text: `${p}: ${c}`, kind: "item" }));
      }
      if (byAction.length > 0) {
        alertLines.push({ text: "By Action", kind: "sub" });
        byAction.forEach(([a, c]) => alertLines.push({ text: `${a}: ${c}`, kind: "item" }));
      }
      if (!hasAlerts) alertLines.push({ text: "No alerts were recorded in this period.", kind: "item" });
      const alertH = Math.max(34, 14 + alertLines.length * 6.2);

      const drawAlertSection = (topY: number): number => {
        const titleY = drawSectionTitle("Alert Summary", topY + 8);
        const panelTop = titleY + 1;
        setFill(hasAlerts ? ALERT_FILL : ALERT_FILL_OK);
        const alertBorder = hasAlerts ? ALERT_LINE : ALERT_LINE_OK;
        setStroke(alertBorder);
        doc.setLineWidth(0.4);
        doc.roundedRect(margin, panelTop, contentW, alertH, 3, 3, "FD");
        let ly = panelTop + 11;
        alertLines.forEach((line) => {
          if (line.kind === "head") {
            doc.setFont("helvetica", "bold");
            doc.setFontSize(9);
            setText(INK);
            doc.text(line.text, margin + 8, ly);
          } else if (line.kind === "sub") {
            ly += 2;
            doc.setFont("helvetica", "bold");
            doc.setFontSize(7.8);
            setText(BRAND);
            doc.text(line.text, margin + 8, ly);
          } else {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            setText(GRAY);
            doc.text(`  ·  ${line.text}`, margin + 8, ly);
          }
          ly += 6.2;
        });
        return panelTop + alertH + 4;
      };

      // Alert panel flows inline after the table (no dedicated page), keeping the
      // report to 1-2 pages no matter how long the window is.
      if (hasAlerts) {
        if (currentY + 50 + alertH > pageHeight - 60) {
          currentY = 24;
          addBrandedPage();
        }
        currentY = drawAlertSection(currentY);
      }

      // ---- Recommendations panel ----
      const suggestions = buildReportSuggestions(report, thresholds);
      const recW = contentW - 24;
      const recPanelH = 14 + suggestions.reduce((acc, s) => acc + doc.splitTextToSize(s, recW).length * 5.6 + 4, 0);
      if (currentY + 40 + recPanelH > pageHeight - 40) {
        currentY = 24;
        addBrandedPage();
      }
      const recTitleY = drawSectionTitle("Recommendations", currentY + 8);
      const recPanelTop = recTitleY + 1;
      setFill(CARD_FILL);
      setStroke(CARD_LINE);
      doc.setLineWidth(0.4);
      doc.roundedRect(margin, recPanelTop, contentW, recPanelH, 3, 3, "FD");
      let ly = recPanelTop + 12;
      suggestions.forEach((s) => {
        const wrapped = doc.splitTextToSize(s, recW) as string[];
        setFill(BRAND_MID);
        doc.circle(margin + 13, ly - 1.4, 1.1, "F");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.2);
        setText(INK);
        doc.text(wrapped, margin + 20, ly);
        ly += wrapped.length * 5.6 + 4;
      });

      const pdfBlob = doc.output("blob");
      const pdfUrl = URL.createObjectURL(pdfBlob);
      if (preview) {
        // Blank tab opened in the click handler above - safe from popup blocking.
        preview.location.href = pdfUrl;
      } else {
        // Popup blocked entirely; a download is the next best outcome.
        const rangeSlug =
          timeRange === "custom" && appliedCustom
            ? `${appliedCustom.from}_to_${appliedCustom.to}`
            : timeRange === "all"
              ? "all-time"
              : timeRange;
        doc.save(`CRAYvings-${selectedDeviceId || "farm"}-${rangeSlug}.pdf`);
      }
      setTimeout(() => {
        URL.revokeObjectURL(pdfUrl);
      }, 60000);
    } catch {
      preview?.close();
      alert("Failed to export the PDF. Please try again.");
    } finally {
      setExportingPdf(false);
    }
  }, [rangeReport, exportingPdf, rangeWindow, timeRange, thresholds, selectedDeviceId, appliedCustom]);

  // Only show loading skeleton on first load; keep previous charts during re-fetch.
  if (activeLoading && (!activeHistory || activeHistory.length === 0)) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-2"></div>
          <div className="h-4 bg-gray-100 rounded w-64"></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[1, 2].map(i => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-20 mb-2"></div>
              <div className="h-8 bg-gray-100 rounded w-16"></div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3">
          {[1, 2].map(i => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse h-48"></div>
          ))}
        </div>
      </div>
    );
  }

  if (historyFetchError && (!activeHistory || activeHistory.length === 0)) {
    return (
      <ErrorCard
        title="Failed to load historical data"
        message="We couldn't reach the server. Please check your connection and try again."
        detail={historyFetchError}
        onRetry={() => setHistoryRetry((n) => n + 1)}
      />
    );
  }

  if (!activeHistory || activeHistory.length === 0) {
    return (
      <div className="space-y-4">
        <TankSelector />
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <History size={40} className="mx-auto mb-3 text-gray-300" />
          <h2 className="text-lg font-bold text-gray-800 mb-1">Historical Data</h2>
          <p className="text-gray-500">No historical data available yet.</p>
          <p className="text-sm text-gray-400 mt-2">Data will appear here once sensors start reporting.</p>
        </div>
      </div>
    );
  }

  const isOnline = connectionStatus === "online";
  const isConnecting = connectionStatus === "connecting";

  return (
    <div className="space-y-4">
      {/* Tank selector: switch which tank's history is shown */}
      <TankSelector />

      {/* Offline warning banner - history is still shown from the database */}
      {connectionStatus === "offline" && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-sm flex items-center gap-2">
          <AlertTriangle size={16} className="shrink-0" />
          <span>
            Device offline — showing recorded data up to{" "}
            {lastUpdate ? formatFarmDateTime(lastUpdate) : "last connection"}
          </span>
        </div>
      )}

      {/* Stale history warning - the last history fetch failed */}
      {historyStale && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-sm flex items-center gap-2">
          <AlertTriangle size={16} className="shrink-0" />
          <span>
            Chart data may be outdated — the latest refresh failed
            {historyLastUpdated
              ? ` (last successful update: ${formatFarmTime(historyLastUpdated)})`
              : ""}. Showing the most recent data we have.
          </span>
        </div>
      )}

      {/* Hero banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 via-brand-400 to-amber-600 text-white shadow-sm">
        <div className="relative p-6 lg:p-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center shrink-0">
              <History size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                Historical Data
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-white/20 border border-white/30">
                  <span className={`w-2 h-2 rounded-full ${isConnecting ? "bg-yellow-300 animate-pulse" : isOnline ? "bg-emerald-300" : "bg-gray-200"}`} />
                  {isConnecting ? "Polling…" : isOnline ? "Live" : "Offline"}
                </span>
              </h1>
              <p className="text-white/80 text-sm mt-1">
                Sensor trends and analysis across the farm
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {lastUpdate && (
              <span className="flex items-center gap-1.5 text-white/90">
                <Clock size={14} /> Updated {formatFarmTime(lastUpdate)}
              </span>
            )}
          </div>
        </div>
        <div className="px-6 lg:px-7 pb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/85">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
            {filteredHistory.length.toLocaleString()} of {activeHistory.length.toLocaleString()} readings
          </span>
          {rangeLabel && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
              {rangeLabel}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
            Coverage {coveragePct != null ? `${coveragePct}%` : "n/a"}
          </span>
        </div>
      </section>

      {/* Range selector + export toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Filter size={16} className="text-gray-400 ml-1" />
          {timeRanges.map((range) => {
            return (
              <button
                key={range.value}
                onClick={() => selectRange(range.value)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  timeRange === range.value
                    ? "bg-orange-500 text-white shadow-sm"
                    : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100"
                }`}
              >
                {range.label}
              </button>
            );
          })}
          {timeRange === "custom" && (
            <>
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                From
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-700"
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                To
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-700"
                />
              </label>
              <button
                onClick={applyCustomRange}
                disabled={!customValid}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                Apply
              </button>
              {!customValid && (
                <span className="text-micro text-amber-600">Pick a start date on or before the end date</span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowMovingAverage(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              showMovingAverage
                ? "bg-orange-100 text-orange-700 border border-orange-200"
                : "bg-gray-50 border border-gray-200 text-gray-500 hover:bg-gray-100"
            }`}
            title="Overlay a 7-point moving average on each chart"
          >
            <Activity size={14} />
            Trend overlay
          </button>
          {isAdmin && filteredHistory.length > 0 && (
            <button
              onClick={handleExportPdf}
              disabled={exportingPdf || rangeReportLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
            <Download size={14} />
            {exportingPdf ? "Exporting..." : "Export PDF"}
            </button>
          )}
        </div>
      </div>

      {/* Period report error banner */}
      {rangeReportError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm flex items-center gap-2">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{rangeReportError}</span>
          <button
            onClick={() => setRangeRetry(n => n + 1)}
            className="ml-auto text-red-600 font-medium underline hover:text-red-800"
          >
            Retry
          </button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-gray-500">
              <Thermometer size={16} className="text-orange-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Temperature</span>
              {latestStatuses.temperature && (
                <span className={`text-micro font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[latestStatuses.temperature]}`}>
                  {latestStatuses.temperature === "good" ? "Safe" : latestStatuses.temperature === "warning" ? "Warning" : "Critical"}
                </span>
              )}
            </div>
            {rangeReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {fmtStat(rangeReport.summary.temp_min, 1)}°
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {fmtStat(rangeReport.summary.temp_avg, 1)}°
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {fmtStat(rangeReport.summary.temp_max, 1)}°
                </span>
              </div>
            ) : stats?.temperature && (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {stats.temperature.min.toFixed(1)}°
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {stats.temperature.avg.toFixed(1)}°
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {stats.temperature.max.toFixed(1)}°
                </span>
              </div>
            )}
          </div>
          <div className={`text-2xl font-bold ${latestStatuses.temperature ? STATUS_TEXT[latestStatuses.temperature] : "text-gray-800"}`}>
            {latestReading?.temperature != null ? Number(latestReading.temperature).toFixed(1) : "--"}<span className="text-base font-normal text-gray-500">°C</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <div className={`text-micro ${breachCounts.temperature > 0 ? "text-amber-600" : "text-gray-400"}`}>
              {filteredHistory.length === 0
                ? "No readings in this window"
                : breachCounts.temperature > 0
                  ? `${breachCounts.temperature} reading${breachCounts.temperature === 1 ? "" : "s"} out of range`
                  : "All readings in range"}
            </div>
            {trends.temperature && (
              <span className={`inline-flex items-center gap-0.5 text-micro font-semibold px-1.5 py-0.5 rounded-full ${
                trends.temperature === "up"
                  ? "text-green-600 bg-green-50"
                  : trends.temperature === "down"
                    ? "text-red-600 bg-red-50"
                    : "text-gray-500 bg-gray-100"
              }`}>
                {trends.temperature === "up"
                  ? <><TrendingUp size={10} /> Rising</>
                  : trends.temperature === "down"
                    ? <><TrendingDown size={10} /> Falling</>
                    : <><Activity size={10} /> Stable</>}
              </span>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-gray-500">
              <Waves size={16} className="text-blue-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Water Level</span>
              {latestStatuses.water_level && (
                <span className={`text-micro font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[latestStatuses.water_level]}`}>
                  {latestStatuses.water_level === "good" ? "Safe" : latestStatuses.water_level === "warning" ? "Warning" : "Critical"}
                </span>
              )}
            </div>
            {rangeReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {fmtStat(rangeReport.summary.water_min, 0)}%
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {fmtStat(rangeReport.summary.water_avg, 0)}%
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {fmtStat(rangeReport.summary.water_max, 0)}%
                </span>
              </div>
            ) : stats?.water_level && (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {stats.water_level.min.toFixed(0)}%
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {stats.water_level.avg.toFixed(0)}%
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {stats.water_level.max.toFixed(0)}%
                </span>
              </div>
            )}
          </div>
          <div className={`text-2xl font-bold ${latestStatuses.water_level ? STATUS_TEXT[latestStatuses.water_level] : "text-gray-800"}`}>
            {latestReading?.water_level != null ? Number(latestReading.water_level).toFixed(0) : "--"}<span className="text-base font-normal text-gray-500">%</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <div className={`text-micro ${breachCounts.water_level > 0 ? "text-amber-600" : "text-gray-400"}`}>
              {filteredHistory.length === 0
                ? "No readings in this window"
                : breachCounts.water_level > 0
                  ? `${breachCounts.water_level} reading${breachCounts.water_level === 1 ? "" : "s"} out of range`
                  : "All readings in range"}
            </div>
            {trends.water_level && (
              <span className={`inline-flex items-center gap-0.5 text-micro font-semibold px-1.5 py-0.5 rounded-full ${
                trends.water_level === "up"
                  ? "text-green-600 bg-green-50"
                  : trends.water_level === "down"
                    ? "text-red-600 bg-red-50"
                    : "text-gray-500 bg-gray-100"
              }`}>
                {trends.water_level === "up"
                  ? <><TrendingUp size={10} /> Rising</>
                  : trends.water_level === "down"
                    ? <><TrendingDown size={10} /> Falling</>
                    : <><Activity size={10} /> Stable</>}
              </span>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-gray-500">
              <FlaskConical size={16} className="text-emerald-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Ammonia</span>
              {latestStatuses.ammonia && (
                <span className={`text-micro font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[latestStatuses.ammonia]}`}>
                  {latestStatuses.ammonia === "good" ? "Safe" : latestStatuses.ammonia === "warning" ? "Warning" : "Critical"}
                </span>
              )}
            </div>
            {rangeReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {fmtStat(rangeReport.summary.ammonia_min, 2)}
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {fmtStat(rangeReport.summary.ammonia_avg, 2)}
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {fmtStat(rangeReport.summary.ammonia_max, 2)}
                </span>
              </div>
            ) : stats?.ammonia && (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {stats.ammonia.min.toFixed(2)}
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {stats.ammonia.avg.toFixed(2)}
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {stats.ammonia.max.toFixed(2)}
                </span>
              </div>
            )}
          </div>
          <div className={`text-2xl font-bold ${latestStatuses.ammonia ? STATUS_TEXT[latestStatuses.ammonia] : "text-gray-800"}`}>
            {latestReading?.ammonia != null ? Number(latestReading.ammonia).toFixed(2) : "--"}<span className="text-base font-normal text-gray-500"> ppm</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <div className={`text-micro ${breachCounts.ammonia > 0 ? "text-amber-600" : "text-gray-400"}`}>
              {filteredHistory.length === 0
                ? "No readings in this window"
                : breachCounts.ammonia > 0
                  ? `${breachCounts.ammonia} reading${breachCounts.ammonia === 1 ? "" : "s"} out of range`
                  : "All readings in range"}
            </div>
            {trends.ammonia && (
              <span className={`inline-flex items-center gap-0.5 text-micro font-semibold px-1.5 py-0.5 rounded-full ${
                trends.ammonia === "up"
                  ? "text-green-600 bg-green-50"
                  : trends.ammonia === "down"
                    ? "text-red-600 bg-red-50"
                    : "text-gray-500 bg-gray-100"
              }`}>
                {trends.ammonia === "up"
                  ? <><TrendingUp size={10} /> Rising</>
                  : trends.ammonia === "down"
                    ? <><TrendingDown size={10} /> Falling</>
                    : <><Activity size={10} /> Stable</>}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Charts */}
      {filteredHistory.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
              <Gauge size={20} className="text-orange-500" />
              Sensor Trends
            </h2>
            <span className="text-xs text-gray-400">
              Green band = configured safe range · {showMovingAverage ? "dashed line = 7-pt average" : "hint: enable the trend overlay"}
            </span>
          </div>
          <TrendCard
            title="Temperature (°C)"
            data={chartHistory}
            dataKey="temperature"
            stroke={SENSOR_COLORS.temperature}
            range={thresholds.temperature.range}
            unit="°C"
            overlayKey={showMovingAverage ? "_tempAvg" : undefined}
            overlayName="7-pt avg"
          />
          <TrendCard
            title="Water Level (%)"
            data={chartHistory}
            dataKey="water_level"
            stroke={SENSOR_COLORS.water_level}
            range={thresholds.water_level.range}
            unit="%"
            overlayKey={showMovingAverage ? "_waterAvg" : undefined}
            overlayName="7-pt avg"
          />
          <TrendCard
            title="Ammonia (ppm)"
            data={chartHistory}
            dataKey="ammonia"
            stroke={SENSOR_COLORS.ammonia}
            range={thresholds.ammonia.range}
            unit=" ppm"
            overlayKey={showMovingAverage ? "_ammoniaAvg" : undefined}
            overlayName="7-pt avg"
          />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <History size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-600 font-medium">No data for selected time range</p>
          <p className="text-sm text-gray-400 mt-1">Try selecting a different time range.</p>
        </div>
      )}

      {/* Window Highlights */}
      {filteredHistory.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
              <Zap size={20} className="text-amber-500" />
              Window Highlights
            </h2>
            {coveragePct != null && (
              <span className="text-xs text-gray-500">
                Est. coverage {coveragePct}% · ~{expectedReadings?.toLocaleString()} readings expected (1/min)
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {SENSOR_KEYS.map((key, i) => {
              const meta = PARAM_META[i];
              const hl = windowHighlights[key];
              const t = thresholds[key];
              const statusOf = (value: number): ThresholdStatus => getThresholdStatus(value, t.range, t.isMinOnly);
              const fmt = (value: number) => `${value.toFixed(meta.decimals)}${meta.unit}`;
              return (
                <div key={key} className="bg-gray-50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-7 h-7 rounded-lg bg-white border border-gray-200 flex items-center justify-center">
                      {createElement(meta.icon, { size: 15, className: meta.tint })}
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wide text-gray-600">{meta.label}</span>
                    <span className="text-micro text-gray-400 ml-auto">
                      safe {t.range.min}–{t.range.max}{meta.unit}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {[
                      { label: "Peak", icon: <TrendingUp size={12} className="text-green-500" />, what: hl.peak },
                      { label: "Lowest", icon: <TrendingDown size={12} className="text-orange-500" />, what: hl.low },
                    ].map(row => {
                      const status = row.what ? statusOf(row.what.value) : null;
                      return (
                        <div key={row.label}>
                          <div className="flex items-center justify-between text-sm text-gray-600">
                            <span className="flex items-center gap-1">{row.icon} {row.label}</span>
                            <span className="font-semibold text-gray-800 flex items-center gap-1.5">
                              {row.what ? (
                                <>
                                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status!]}`} />
                                  <span className={status ? STATUS_TEXT[status] : ""}>{fmt(row.what.value)}</span>
                                </>
                              ) : "—"}
                            </span>
                          </div>
                          <div className="text-micro text-gray-400 text-right mt-0.5">
                            {row.what?.time ? formatFarmDateTime(row.what.time) : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Reading Breakdown - the most recent raw readings in the window */}
      {filteredHistory.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-4">
            <History size={20} className="text-orange-500" />
            Reading Breakdown
            <span className="ml-auto text-xs font-semibold text-gray-500">
              Last {Math.min(filteredHistory.length, 15)} readings
            </span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-3 py-2.5 text-left text-xs font-bold text-gray-500 uppercase">Time</th>
                  {SENSOR_KEYS.map((key) => {
                    const meta = PARAM_META[SENSOR_KEYS.indexOf(key)];
                    const t = thresholds[key];
                    return (
                      <th
                        key={key}
                        className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase"
                        title={`Safe range ${t.range.min}-${t.range.max}${meta.unit}`}
                      >
                        {meta.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filteredHistory.slice(-15).reverse().map((item, i) => (
                  <tr key={item.timestamp ?? i} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap text-xs">
                      {formatFarmDateTime(item.timestamp)}
                    </td>
                    {SENSOR_KEYS.map((key) => {
                      const meta = PARAM_META[SENSOR_KEYS.indexOf(key)];
                      const value = item[key];
                      const num = typeof value === "number" && Number.isFinite(value) ? value : NaN;
                      const t = thresholds[key];
                      const status = Number.isFinite(num) ? getThresholdStatus(num, t.range, t.isMinOnly) : null;
                      return (
                        <td key={key} className="px-3 py-2 text-center">
                          {status && Number.isFinite(num) ? (
                            <span className="inline-flex items-center gap-1.5 justify-center">
                              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status]}`} />
                              <span className={STATUS_TEXT[status]}>
                                {num.toFixed(meta.decimals)}{meta.unit}
                              </span>
                            </span>
                          ) : "--"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Period Breakdown - one row per hour/day bucket for the selected window */}
      {rangeReportLoading && !rangeReport && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4"></div>
          <div className="h-4 bg-gray-100 rounded w-full mb-2"></div>
          <div className="h-4 bg-gray-100 rounded w-full mb-2"></div>
          <div className="h-4 bg-gray-100 rounded w-3/4"></div>
        </div>
      )}

      {rangeReport && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-4">
              <Calendar size={20} className="text-orange-500" />
              Period Breakdown
              <span className="ml-auto text-xs font-semibold text-gray-500">
                {rangeReport.bucket === "hour" ? "Hourly" : "Daily"} ·{" "}
                {rangeReport.daily.length} {rangeReport.bucket === "hour" ? "hour" : "day"}
                {rangeReport.daily.length === 1 ? "" : "s"}
              </span>
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2.5 text-left text-xs font-bold text-gray-500 uppercase">
                      {rangeReport.bucket === "hour" ? "Hour" : "Date"}
                    </th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Avg Temp</th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Temp Range</th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Avg Water</th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Water Range</th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Avg Ammonia</th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Ammonia Range</th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Readings</th>
                    <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-500 uppercase">Alerts</th>
                  </tr>
                </thead>
                <tbody>
                  {rangeReport.daily.map((day) => (
                    <tr key={day.date} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">
                        {rangeReport.bucket === "hour"
                          ? formatFarmDateTime(bucketInstant(day.date))
                          : formatFarmDate(day.date)}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{fmtStat(day.temp_avg, 1)}°C</td>
                      <td className="px-3 py-2.5 text-center text-gray-500 text-xs">
                        {fmtStat(day.temp_min, 1)} - {fmtStat(day.temp_max, 1)}°C
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{fmtStat(day.water_avg, 0)}%</td>
                      <td className="px-3 py-2.5 text-center text-gray-500 text-xs">
                        {fmtStat(day.water_min, 0)} - {fmtStat(day.water_max, 0)}%
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{fmtStat(day.ammonia_avg, 2)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-500 text-xs">
                        {fmtStat(day.ammonia_min, 2)} - {fmtStat(day.ammonia_max, 2)}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{(day.readings ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          day.alerts > 0
                            ? "bg-red-100 text-red-700"
                            : "bg-green-100 text-green-700"
                        }`}>
                          {day.alerts}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Alert Summary */}
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-4">
              <AlertTriangle size={20} className="text-amber-500" />
              Alert Summary
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-gray-50 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-gray-800">{rangeReport.alerts.total}</div>
                <div className="text-xs text-gray-500 mt-1">Total Alerts</div>
              </div>
              {Object.entries(rangeReport.alerts.by_parameter).map(([param, count]) => (
                <div key={param} className="bg-gray-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-gray-800">{count}</div>
                  <div className="text-xs text-gray-500 mt-1">{param}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}