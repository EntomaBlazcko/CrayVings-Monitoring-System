// =============================================================================
// src/pages/HistoricalDataPage.tsx
// Historical data analysis with time-range filtering, trend overlays,
// window highlights, reading breakdown, and weekly PDF report.
// =============================================================================

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
import { useSensors } from "../hooks/useSensors";
import { useAuth } from "../contexts/useAuth";
import { fetchSensorHistory, fetchWeeklyReport, fetchRangeReport } from "../api/client";
import { isAxiosError } from "axios";
import { getSettingsThresholds, getThresholdStatus, type ThresholdStatus } from "../types";
import type { ChartPoint, WeeklyReport } from "../types";
import { formatFarmTime, formatFarmDate, formatFarmDateTime } from "../utils/time";

// Detects AbortError from AbortController cancellation (native fetch or axios).
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "AbortError";
  return isAxiosError(err) && (err.code === "ERR_CANCELED" || err.name === "CanceledError");
}

type TimeRange = "1h" | "6h" | "24h" | "1w" | "all";
type SensorKey = "temperature" | "water_level" | "ammonia";

const SENSOR_KEYS: SensorKey[] = ["temperature", "water_level", "ammonia"];

const PARAM_META: { label: string; icon: typeof Thermometer; tint: string; stroke: string; unit: string; decimals: number }[] = [
  { label: "Temperature", icon: Thermometer, tint: "text-orange-500", stroke: "#f97316", unit: "°C", decimals: 1 },
  { label: "Water Level", icon: Waves, tint: "text-blue-500", stroke: "#2563eb", unit: "%", decimals: 0 },
  { label: "Ammonia", icon: FlaskConical, tint: "text-emerald-500", stroke: "#10b981", unit: "ppm", decimals: 2 },
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
  const { history, loading, connectionStatus, lastUpdate, historyStale, historyLastUpdated, settings } = useSensors();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [showMovingAverage, setShowMovingAverage] = useState(true);
  const [dynamicHistory, setDynamicHistory] = useState<ChartPoint[]>([]);
  const [dynamicLoading, setDynamicLoading] = useState(false);
  const [historyFetchError, setHistoryFetchError] = useState<string | null>(null);
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport | null>(null);
  const [weeklyReportLoading, setWeeklyReportLoading] = useState(false);
  const [weeklyReportError, setWeeklyReportError] = useState<string | null>(null);
  const [weeklyRetry, setWeeklyRetry] = useState(0);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [exportingPdf, setExportingPdf] = useState(false);

  const timeRanges: { value: TimeRange; label: string }[] = [
    { value: "1h", label: "1 Hour" },
    { value: "6h", label: "6 Hours" },
    { value: "24h", label: "24 Hours" },
    { value: "1w", label: "1 Week" },
    { value: "all", label: "All Time" },
  ];

  const getLimitForRange = (range: TimeRange): number => {
    switch (range) {
      case "1h": return 60;
      case "6h": return 360;
      case "24h": return 1440;
      case "1w": return 2000;
      case "all": return 1000;
    }
  };

  // Always fetches from server (DB), so it works offline. Provider history is only seed.
  const fetchDynamicData = useCallback(async (range: TimeRange, signal: AbortSignal) => {
    const limit = getLimitForRange(range);
    const data = await fetchSensorHistory(limit, signal);
    return data;
  }, []);

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

  useEffect(() => {
    if (timeRange !== "1w") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWeeklyReport(null);
      setWeeklyReportError(null);
      return;
    }

    const controller = new AbortController();
    setWeeklyReportLoading(true);
    setWeeklyReportError(null);

    fetchWeeklyReport(controller.signal)
      .then(data => {
        setWeeklyReport(data);
        setWeeklyReportLoading(false);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) {
          setWeeklyReportError((err as Error)?.message || 'Failed to load weekly report');
          setWeeklyReportLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [timeRange, weeklyRetry]);

  const activeHistory = dynamicHistory.length > 0 ? dynamicHistory : history;
  const activeLoading = dynamicLoading || loading;

  // Milliseconds since the last recorded reading (0 when not offline / unknown).
  const offlineForMs =
    connectionStatus === "offline" && lastUpdate
      ? Date.now() - new Date(lastUpdate).getTime()
      : 0;

  // Window length for each range; null = always enabled ("All Time").
  const rangeWindowMs: Record<TimeRange, number | null> = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    all: null,
  };

  const isRangeUnavailable = (range: TimeRange): boolean => {
    const window = rangeWindowMs[range];
    return window !== null && offlineForMs > window;
  };

  const filteredHistory = useMemo(() => {
    if (!activeHistory || activeHistory.length === 0) return [];

    const sorted = [...activeHistory].sort((a, b) => {
      const ta = new Date(a.timestamp || 0).getTime();
      const tb = new Date(b.timestamp || 0).getTime();
      return ta - tb;
    });

    if (timeRange === "all") return sorted;

    const hours = timeRange === "1h" ? 1 : timeRange === "6h" ? 6 : timeRange === "1w" ? 168 : 24;
    const cutoff = Date.now() - hours * 60 * 60 * 1000;

    return sorted.filter((item) => {
      if (!item.timestamp) return false;
      return new Date(item.timestamp).getTime() >= cutoff;
    });
  }, [activeHistory, timeRange]);

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

  const thresholds = useMemo(() => getSettingsThresholds(settings), [settings]);

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
  const expectedReadings = useMemo(() => {
    if (timeRange === "all") return null;
    const hours = timeRange === "1h" ? 1 : timeRange === "6h" ? 6 : timeRange === "1w" ? 168 : 24;
    return hours * 60;
  }, [timeRange]);

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

    const isWeekly = timeRange === "1w";
    let report = isWeekly ? weeklyReport : null;
    if (!report) {
      setExportingPdf(true);
      try {
        report = isWeekly
          ? await fetchWeeklyReport()
          : await fetchRangeReport(timeRange === "all" ? null : timeRange === "1h" ? 1 : timeRange === "6h" ? 6 : 24);
      } catch {
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
      const INK: number[] = [30, 41, 59];
      const GRAY: number[] = [107, 114, 128];
      const WHITE: number[] = [255, 255, 255];
      const BRAND: number[] = [217, 75, 30];
      const BRAND_MID: number[] = [234, 88, 12];
      const AMBER: number[] = [245, 158, 11];
      const CARD_FILL: number[] = [255, 250, 245];
      const CARD_LINE: number[] = [253, 230, 210];
      const ZEBRA: number[] = [255, 249, 243];
      const LINE: number[] = [226, 232, 240];
      const PARAM: Record<string, number[]> = {
        temperature: [249, 115, 22],
        water_level: [37, 99, 235],
        ammonia: [16, 185, 129],
      };

      const margin = 12;
      const contentW = pageWidth - margin * 2;

      const setFill = (c: number[]) => doc.setFillColor(c[0], c[1], c[2]);
      const setText = (c: number[]) => doc.setTextColor(c[0], c[1], c[2]);
      const lerp = (a: number[], b: number[], t: number) =>
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round);

      // Warm vertical gradient that brands the top of the first page.
      const drawHeaderBand = (h: number) => {
        const steps = 32;
        for (let i = 0; i < steps; i++) {
          const t = i / (steps - 1);
          const c =
            t < 0.5
              ? lerp([196, 50, 17], BRAND_MID, t * 2)
              : lerp(BRAND_MID, AMBER, (t - 0.5) * 2);
          doc.setFillColor(c[0], c[1], c[2]);
          doc.rect(0, (h / steps) * i, pageWidth, h / steps + 1, "F");
        }
      };

      // Slim branded strip reused on every page after the first.
      const drawSlimHeader = () => {
        setFill([199, 62, 25]);
        doc.rect(0, 0, pageWidth, 11, "F");
        setFill(AMBER);
        doc.rect(0, 11, pageWidth, 1.4, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(6.8);
        setText(WHITE);
        doc.text(`CRAYvings  ·  ${isWeekly ? "Weekly Report" : "History Report"}`, margin, 7.5);
      };

      const drawFooter = (pageNumber: number) => {
        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.5);
        doc.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(148, 163, 184);
        doc.text("CRAYvings Monitoring System", margin, pageHeight - 7);
        doc.text(`Page ${pageNumber}`, pageWidth / 2, pageHeight - 7, { align: "center" });
        doc.text(`Exported: ${formatFarmDate(new Date())}`, pageWidth - margin, pageHeight - 7, { align: "right" });
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
      const title = isWeekly ? "CRAYvings Weekly Report" : "CRAYvings History Report";

      // ---- Header band ----
      const bandH = 52;
      drawHeaderBand(bandH);
      setFill(AMBER);
      doc.rect(0, bandH, pageWidth, 2.2, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      setText(WHITE);
      doc.text(title, pageWidth / 2, 20, { align: "center" });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.text("Smart Aquaculture · Water Quality Monitoring", pageWidth / 2, 30, { align: "center" });
      doc.text(`Period: ${startDate} - ${endDate}`, pageWidth / 2, 40, { align: "center" });
      doc.setFontSize(7.5);
      doc.setTextColor(255, 231, 213);
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
          avg: `${(summary.temp_avg ?? 0).toFixed(1)}°C`,
          minmax: `Min ${(summary.temp_min ?? 0).toFixed(1)} · Max ${(summary.temp_max ?? 0).toFixed(1)}`,
        },
        {
          label: "Water Level",
          color: PARAM.water_level,
          avg: `${(summary.water_avg ?? 0).toFixed(0)}%`,
          minmax: `Min ${(summary.water_min ?? 0).toFixed(0)} · Max ${(summary.water_max ?? 0).toFixed(0)}`,
        },
        {
          label: "Ammonia",
          color: PARAM.ammonia,
          avg: `${(summary.ammonia_avg ?? 0).toFixed(2)} ppm`,
          minmax: `Min ${(summary.ammonia_min ?? 0).toFixed(2)} · Max ${(summary.ammonia_max ?? 0).toFixed(2)}`,
        },
      ];
      cards.forEach((c, i) => {
        const x = margin + i * (cardW + gap);
        setFill(CARD_FILL);
        doc.setDrawColor(CARD_LINE[0], CARD_LINE[1], CARD_LINE[2]);
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
          valueColor: (report.alerts.total ?? 0) > 0 ? [217, 68, 30] : [16, 185, 129],
        },
      ];
      totals.forEach((t, i) => {
        const x = margin + i * (chipW + gap);
        setFill([248, 250, 252]);
        doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
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

      // Range exports stay compact: smaller font, capped rows and no separate
      // alert page, so long windows (e.g. "All Time") fit on 1-2 pages.
      const cappedBuckets = report.bucket ? report.daily.slice(-60) : report.daily;
      const capNote =
        report.daily.length > cappedBuckets.length
          ? `Showing the last ${cappedBuckets.length} ${report.bucket === "hour" ? "hourly" : "daily"} buckets - the summary above covers the full period.`
          : null;
      const unitLabel = report.bucket === "hour" ? "Hour" : "Date";
      const fmtBucket = report.bucket === "hour" ? formatFarmDateTime : formatFarmDate;
      const isRange = !!report.bucket;

      autoTable(doc, {
        startY: tableStartY,
        head: [[unitLabel, "Temp Avg", "Temp Range", "Water Avg", "Water Range", "Ammonia Avg", "Ammonia Range", "Readings", "Alerts"]],
        body: cappedBuckets.map(d => [
          fmtBucket(d.date),
          `${(d.temp_avg ?? 0).toFixed(1)}°C`,
          `${(d.temp_min ?? 0).toFixed(1)} - ${(d.temp_max ?? 0).toFixed(1)}°C`,
          `${(d.water_avg ?? 0).toFixed(0)}%`,
          `${(d.water_min ?? 0).toFixed(0)} - ${(d.water_max ?? 0).toFixed(0)}%`,
          `${(d.ammonia_avg ?? 0).toFixed(2)} ppm`,
          `${(d.ammonia_min ?? 0).toFixed(2)} - ${(d.ammonia_max ?? 0).toFixed(2)} ppm`,
          (d.readings ?? 0).toLocaleString(),
          String(d.alerts ?? 0),
        ]),
        theme: "grid",
        styles: {
          fontSize: isRange ? 7.2 : 7.6,
          cellPadding: isRange ? 1.7 : 2,
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
          0: { cellWidth: isRange ? 46 : 34, halign: "left" },
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
        setFill([255, 247, 237]);
        doc.setDrawColor(254, 215, 170);
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
        setFill(hasAlerts ? [255, 244, 230] : [240, 253, 244]);
        const alertBorder = hasAlerts ? [253, 186, 116] : [167, 243, 208];
        doc.setDrawColor(alertBorder[0], alertBorder[1], alertBorder[2]);
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

      if (isRange) {
        if (hasAlerts) {
          if (currentY + 50 + alertH > pageHeight - 60) {
            currentY = 24;
            addBrandedPage();
          }
          currentY = drawAlertSection(currentY);
        }
      } else if (hasAlerts) {
        // Weekly keeps its dedicated alert page (existing behavior).
        currentY = 24;
        addBrandedPage();
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
      doc.setDrawColor(CARD_LINE[0], CARD_LINE[1], CARD_LINE[2]);
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

      doc.save(
        isWeekly
          ? `CRAYvings_Weekly_Report_${new Date().toISOString().split("T")[0]}.pdf`
          : `CRAYvings_History_Report_${timeRange === "all" ? "All_Time" : timeRange.toUpperCase()}_${new Date().toISOString().split("T")[0]}.pdf`
      );
    } catch {
      alert("Failed to export the PDF. Please try again.");
    } finally {
      setExportingPdf(false);
    }
  }, [weeklyReport, exportingPdf, timeRange, thresholds]);

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
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <History size={40} className="mx-auto mb-3 text-gray-300" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Historical Data</h2>
        <p className="text-gray-500">No historical data available yet.</p>
        <p className="text-sm text-gray-400 mt-2">Data will appear here once sensors start reporting.</p>
      </div>
    );
  }

  const isOnline = connectionStatus === "online";
  const isConnecting = connectionStatus === "connecting";

  const firstTs = filteredHistory[0]?.timestamp;
  const lastTs = filteredHistory[filteredHistory.length - 1]?.timestamp;

  return (
    <div className="space-y-4">
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
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#d94b1e] via-[#ef6a2e] to-amber-600 text-white shadow-sm">
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
          {firstTs && lastTs && timeRange !== "1w" && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
              {formatFarmTime(firstTs)} → {formatFarmTime(lastTs)}
            </span>
          )}
          {timeRange === "1w" && weeklyReport && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
              {formatFarmDate(weeklyReport.period.start)} → {formatFarmDate(weeklyReport.period.end)}
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
            const unavailable = isRangeUnavailable(range.value);
            const offlineHours = Math.max(1, Math.floor(offlineForMs / (60 * 60 * 1000)));
            return (
              <button
                key={range.value}
                onClick={() => setTimeRange(range.value)}
                disabled={unavailable}
                title={
                  unavailable
                    ? `Device has been offline for ${offlineHours}h — no readings in this window`
                    : undefined
                }
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  timeRange === range.value
                    ? "bg-orange-500 text-white shadow-sm"
                    : unavailable
                      ? "bg-gray-50 border border-gray-200 text-gray-300 cursor-not-allowed"
                      : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100"
                }`}
              >
                {range.label}
              </button>
            );
          })}
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
          {isAdmin && (timeRange === "1w" ? true : filteredHistory.length > 0) && (
            <button
              onClick={handleExportPdf}
              disabled={exportingPdf || (timeRange === "1w" && weeklyReportLoading)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-[#c2410c] text-white hover:bg-[#a13a0a] disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
            <Download size={14} />
            {exportingPdf ? "Exporting..." : "Export PDF"}
            </button>
          )}
        </div>
      </div>

      {/* Weekly report error banner */}
      {timeRange === "1w" && weeklyReportError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm flex items-center gap-2">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{weeklyReportError}</span>
          <button
            onClick={() => setWeeklyRetry(n => n + 1)}
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
                <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[latestStatuses.temperature]}`}>
                  {latestStatuses.temperature === "good" ? "Safe" : latestStatuses.temperature === "warning" ? "Warning" : "Critical"}
                </span>
              )}
            </div>
            {timeRange === "1w" && weeklyReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {(weeklyReport.summary.temp_min ?? 0).toFixed(1)}°
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {(weeklyReport.summary.temp_avg ?? 0).toFixed(1)}°
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {(weeklyReport.summary.temp_max ?? 0).toFixed(1)}°
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
            <div className={`text-[10px] ${breachCounts.temperature > 0 ? "text-amber-600" : "text-gray-400"}`}>
              {filteredHistory.length === 0
                ? "No readings in this window"
                : breachCounts.temperature > 0
                  ? `${breachCounts.temperature} reading${breachCounts.temperature === 1 ? "" : "s"} out of range`
                  : "All readings in range"}
            </div>
            {trends.temperature && (
              <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
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
                <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[latestStatuses.water_level]}`}>
                  {latestStatuses.water_level === "good" ? "Safe" : latestStatuses.water_level === "warning" ? "Warning" : "Critical"}
                </span>
              )}
            </div>
            {timeRange === "1w" && weeklyReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {(weeklyReport.summary.water_min ?? 0).toFixed(0)}%
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {(weeklyReport.summary.water_avg ?? 0).toFixed(0)}%
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {(weeklyReport.summary.water_max ?? 0).toFixed(0)}%
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
            <div className={`text-[10px] ${breachCounts.water_level > 0 ? "text-amber-600" : "text-gray-400"}`}>
              {filteredHistory.length === 0
                ? "No readings in this window"
                : breachCounts.water_level > 0
                  ? `${breachCounts.water_level} reading${breachCounts.water_level === 1 ? "" : "s"} out of range`
                  : "All readings in range"}
            </div>
            {trends.water_level && (
              <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
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
                <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[latestStatuses.ammonia]}`}>
                  {latestStatuses.ammonia === "good" ? "Safe" : latestStatuses.ammonia === "warning" ? "Warning" : "Critical"}
                </span>
              )}
            </div>
            {timeRange === "1w" && weeklyReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-orange-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {(weeklyReport.summary.ammonia_min ?? 0).toFixed(2)}
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {(weeklyReport.summary.ammonia_avg ?? 0).toFixed(2)}
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {(weeklyReport.summary.ammonia_max ?? 0).toFixed(2)}
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
            <div className={`text-[10px] ${breachCounts.ammonia > 0 ? "text-amber-600" : "text-gray-400"}`}>
              {filteredHistory.length === 0
                ? "No readings in this window"
                : breachCounts.ammonia > 0
                  ? `${breachCounts.ammonia} reading${breachCounts.ammonia === 1 ? "" : "s"} out of range`
                  : "All readings in range"}
            </div>
            {trends.ammonia && (
              <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
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
            stroke="#f97316"
            range={thresholds.temperature.range}
            unit="°C"
            overlayKey={showMovingAverage ? "_tempAvg" : undefined}
            overlayName="7-pt avg"
          />
          <TrendCard
            title="Water Level (%)"
            data={chartHistory}
            dataKey="water_level"
            stroke="#2563eb"
            range={thresholds.water_level.range}
            unit="%"
            overlayKey={showMovingAverage ? "_waterAvg" : undefined}
            overlayName="7-pt avg"
          />
          <TrendCard
            title="Ammonia (ppm)"
            data={chartHistory}
            dataKey="ammonia"
            stroke="#10b981"
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
                    <span className="text-[10px] text-gray-400 ml-auto">
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
                          <div className="text-[10px] text-gray-400 text-right mt-0.5">
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

      {/* Reading Breakdown - recent readings table for non-weekly ranges */}
      {timeRange !== "1w" && filteredHistory.length > 0 && (
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

      {/* Weekly Report Breakdown */}
      {timeRange === "1w" && weeklyReportLoading && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-4"></div>
          <div className="h-4 bg-gray-100 rounded w-full mb-2"></div>
          <div className="h-4 bg-gray-100 rounded w-full mb-2"></div>
          <div className="h-4 bg-gray-100 rounded w-3/4"></div>
        </div>
      )}

      {timeRange === "1w" && weeklyReport && !weeklyReportLoading && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-4">
              <Calendar size={20} className="text-orange-500" />
              Weekly Breakdown
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2.5 text-left text-xs font-bold text-gray-500 uppercase">Date</th>
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
                  {weeklyReport.daily.map((day) => (
                    <tr key={day.date} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">
                        {formatFarmDate(day.date)}
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{(day.temp_avg ?? 0).toFixed(1)}°C</td>
                      <td className="px-3 py-2.5 text-center text-gray-500 text-xs">
                        {(day.temp_min ?? 0).toFixed(1)} - {(day.temp_max ?? 0).toFixed(1)}°C
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{(day.water_avg ?? 0).toFixed(0)}%</td>
                      <td className="px-3 py-2.5 text-center text-gray-500 text-xs">
                        {(day.water_min ?? 0).toFixed(0)} - {(day.water_max ?? 0).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2.5 text-center text-gray-600">{(day.ammonia_avg ?? 0).toFixed(2)}</td>
                      <td className="px-3 py-2.5 text-center text-gray-500 text-xs">
                        {(day.ammonia_min ?? 0).toFixed(2)} - {(day.ammonia_max ?? 0).toFixed(2)}
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
                <div className="text-2xl font-bold text-gray-800">{weeklyReport.alerts.total}</div>
                <div className="text-xs text-gray-500 mt-1">Total Alerts</div>
              </div>
              {Object.entries(weeklyReport.alerts.by_parameter).map(([param, count]) => (
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