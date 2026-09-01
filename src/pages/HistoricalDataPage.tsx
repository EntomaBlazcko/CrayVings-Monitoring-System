// =============================================================================
// FILE: src/pages/HistoricalDataPage.tsx
// =============================================================================
// PURPOSE: Historical data analysis page with time-range filtering.
//
// This page allows users to view sensor trends over different time periods:
//   1. Time range selector: 1 Hour / 6 Hours / 24 Hours / All Time
//   2. Two summary cards showing Min/Average/Max for each sensor
//   3. Two full-width line charts (vertical layout for readability)
//
// FEATURES:
//   - Dynamically fetches more data from the backend for longer time ranges
//   - Uses AbortController to cancel stale requests when switching ranges
//   - Filters and sorts data client-side for the selected time window
//   - Shows loading skeletons during data fetch
//
// DATA FLOW:
//   - Short ranges (1h, 6h): Uses locally cached history from SensorProvider
//   - Long ranges (24h, all): Fetches additional data directly from API
//   - Data is filtered by timestamp cutoff based on selected range
// =============================================================================

import { useState, useMemo, useEffect, useCallback } from "react";
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
} from "lucide-react";
import TrendCard from "../components/TrendCard";
import { ErrorCard } from "../components/Loading";
import { useSensors } from "../hooks/useSensors";
import { fetchSensorHistory, fetchWeeklyReport } from "../api/client";
import { isAxiosError } from "axios";
import type { ChartPoint, WeeklyReport } from "../types";

// Detects a request that was cancelled by an AbortController. React
// (fetch) throws a native AbortError, while axios surfaces the same
// cancellation as ERR_CANCELED / CanceledError. Checking both avoids
// setting a spurious error on every range switch (the effect cleanup
// aborts the previous request).
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "AbortError";
  return isAxiosError(err) && (err.code === "ERR_CANCELED" || err.name === "CanceledError");
}

type TimeRange = "1h" | "6h" | "24h" | "1w" | "all";

/**
 * Calculates min, max, and average statistics for each sensor parameter.
 * Returns null if no data is available.
 */
function getStats(data: { temperature?: number | string | null; water_level?: number | string | null; ammonia?: number | string | null }[]) {
  if (!data || data.length === 0) return null;

  const calc = (key: "temperature" | "water_level" | "ammonia") => {
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

export default function HistoricalDataPage() {
  const { history, loading, connectionStatus, lastUpdate } = useSensors();
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
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

  // The page always fetches its own history from the server (the DB), so it
  // keeps working even when the live device is offline. Provider `history` is
  // only used as an instant seed while the page fetch is in flight.
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
        }
        setWeeklyReportLoading(false);
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

  const handleExportPdf = useCallback(async () => {
    if (exportingPdf) return;

    let report = weeklyReport;
    if (!report) {
      setExportingPdf(true);
      try {
        report = await fetchWeeklyReport();
      } catch {
        alert("Failed to fetch weekly report data.");
        setExportingPdf(false);
        return;
      }
    }

    try {
      // jspdf is heavy (~150kB+), so it's only loaded when the user actually
      // exports a PDF rather than when this page opens.
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);

      const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("CRAYvings Weekly Report", pageWidth / 2, 20, { align: "center" });

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const startDate = new Date(report.period.start).toLocaleDateString();
    const endDate = new Date(report.period.end).toLocaleDateString();
    doc.text(`Period: ${startDate} - ${endDate}`, pageWidth / 2, 28, { align: "center" });
    doc.text(`Generated on ${new Date().toLocaleString()}`, pageWidth / 2, 34, { align: "center" });

    const summary = report.summary;
    const summaryY = 40;
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("Summary", 14, summaryY);

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const s = [
      `Temperature: Avg ${(summary.temp_avg ?? 0).toFixed(1)}°C, Min ${(summary.temp_min ?? 0).toFixed(1)}°C, Max ${(summary.temp_max ?? 0).toFixed(1)}°C`,
      `Water Level: Avg ${(summary.water_avg ?? 0).toFixed(0)}%, Min ${(summary.water_min ?? 0).toFixed(0)}%, Max ${(summary.water_max ?? 0).toFixed(0)}%`,
      `Ammonia: Avg ${(summary.ammonia_avg ?? 0).toFixed(2)} ppm, Min ${(summary.ammonia_min ?? 0).toFixed(2)} ppm, Max ${(summary.ammonia_max ?? 0).toFixed(2)} ppm`,
      `Total Readings: ${(summary.total_readings ?? 0).toLocaleString()}`,
      `Total Alerts: ${report.alerts.total ?? 0}`,
    ];
    let sy = summaryY + 7;
    s.forEach(line => { doc.text(line, 14, sy); sy += 5; });

    const tableStartY = sy + 6;
    autoTable(doc, {
      startY: tableStartY,
      head: [["Date", "Temp Avg", "Temp Range", "Water Avg", "Water Range", "Ammonia Avg", "Ammonia Range", "Readings", "Alerts"]],
      body: report.daily.map(d => [
        new Date(d.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        `${(d.temp_avg ?? 0).toFixed(1)}°C`,
        `${(d.temp_min ?? 0).toFixed(1)} - ${(d.temp_max ?? 0).toFixed(1)}°C`,
        `${(d.water_avg ?? 0).toFixed(0)}%`,
        `${(d.water_min ?? 0).toFixed(0)} - ${(d.water_max ?? 0).toFixed(0)}%`,
        `${(d.ammonia_avg ?? 0).toFixed(2)} ppm`,
        `${(d.ammonia_min ?? 0).toFixed(2)} - ${(d.ammonia_max ?? 0).toFixed(2)} ppm`,
        (d.readings ?? 0).toLocaleString(),
        String(d.alerts ?? 0),
      ]),
      styles: { fontSize: 8, cellPadding: 2.5, valign: "middle" },
      headStyles: { fillColor: [241, 245, 249], textColor: [30, 41, 59], fontStyle: "bold", halign: "center" },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 38 },
        1: { halign: "center" },
        2: { halign: "center" },
        3: { halign: "center" },
        4: { halign: "center" },
        5: { halign: "center" },
        6: { halign: "center" },
        7: { halign: "center" },
        8: { halign: "center" },
      },
      margin: { left: 14, right: 14 },
      didDrawPage: (data) => {
        data.doc.setFontSize(8);
        data.doc.setFont("helvetica", "normal");
        data.doc.setTextColor(128, 128, 128);
        data.doc.text(`Page ${data.pageNumber}`, pageWidth / 2, pageHeight - 10, { align: "center" });
        data.doc.text("CRAYvings Monitoring System", 14, pageHeight - 10);
        data.doc.text(`Exported: ${new Date().toLocaleDateString()}`, pageWidth - 14, pageHeight - 10, { align: "right" });
      },
    });

    // Alert summary on a new page
    if (Object.keys(report.alerts.by_parameter).length > 0 || Object.keys(report.alerts.by_action).length > 0) {
      doc.addPage();
      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.text("Alert Summary", 14, 20);

      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      let ay = 30;
      doc.text(`Total Alerts: ${report.alerts.total}`, 14, ay);
      ay += 7;

      if (Object.keys(report.alerts.by_parameter).length > 0) {
        doc.setFont("helvetica", "bold");
        doc.text("By Parameter:", 14, ay);
        ay += 5;
        doc.setFont("helvetica", "normal");
        Object.entries(report.alerts.by_parameter).forEach(([param, count]) => {
          doc.text(`  ${param}: ${count}`, 14, ay);
          ay += 5;
        });
        ay += 3;
      }

      if (Object.keys(report.alerts.by_action).length > 0) {
        doc.setFont("helvetica", "bold");
        doc.text("By Action:", 14, ay);
        ay += 5;
        doc.setFont("helvetica", "normal");
        Object.entries(report.alerts.by_action).forEach(([action, count]) => {
          doc.text(`  ${action}: ${count}`, 14, ay);
          ay += 5;
        });
      }

      // Footer on alert page
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(128, 128, 128);
      doc.text("CRAYvings Monitoring System", 14, pageHeight - 10);
      doc.text(`Exported: ${new Date().toLocaleDateString()}`, pageWidth - 14, pageHeight - 10, { align: "right" });
    }

    doc.save(`CRAYvings_Weekly_Report_${new Date().toISOString().split("T")[0]}.pdf`);
    } catch {
      alert("Failed to export the PDF. Please try again.");
    } finally {
      setExportingPdf(false);
    }
  }, [weeklyReport, exportingPdf]);

  // Only show the loading skeleton on the very first load — keep the previous
  // range's charts on screen while re-fetching after a range switch.
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

  return (
    <div className="space-y-4">
      {/* Offline warning banner - history is still shown from the database */}
      {connectionStatus === "offline" && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-sm flex items-center gap-2">
          <AlertTriangle size={16} className="shrink-0" />
          <span>
            Device offline — showing recorded data up to{" "}
            {lastUpdate ? new Date(lastUpdate).toLocaleString() : "last connection"}
          </span>
        </div>
      )}

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <History size={22} className="text-blue-500" />
              Historical Data
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              View sensor trends over time
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Filter size={16} className="text-gray-400" />
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
                      ? "bg-blue-500 text-white shadow-sm"
                      : unavailable
                        ? "bg-gray-50 border border-gray-200 text-gray-300 cursor-not-allowed"
                        : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {range.label}
                </button>
              );
            })}
            {timeRange === "1w" && (
              <button
                onClick={handleExportPdf}
                disabled={exportingPdf || weeklyReportLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-[#c2410c] text-white hover:bg-[#a13a0a] disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <Download size={14} />
                {exportingPdf ? "Exporting..." : "Export PDF"}
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 text-sm text-gray-400">
          Showing {filteredHistory.length} of {history.length} readings
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
            </div>
            {timeRange === "1w" && weeklyReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-blue-600" title="Min">
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
                <span className="text-blue-600" title="Min">
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
          <div className="text-2xl font-bold text-gray-800">
            {latestReading?.temperature != null ? Number(latestReading.temperature).toFixed(1) : "--"}<span className="text-base font-normal text-gray-500">°C</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-gray-500">
              <Waves size={16} className="text-blue-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Water Level</span>
            </div>
            {timeRange === "1w" && weeklyReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-blue-600" title="Min">
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
                <span className="text-blue-600" title="Min">
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
          <div className="text-2xl font-bold text-gray-800">
            {latestReading?.water_level != null ? Number(latestReading.water_level).toFixed(0) : "--"}<span className="text-base font-normal text-gray-500">%</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-gray-500">
              <FlaskConical size={16} className="text-emerald-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Ammonia</span>
            </div>
            {timeRange === "1w" && weeklyReport ? (
              <div className="flex gap-3 text-xs">
                <span className="text-blue-600" title="Min">
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
                <span className="text-blue-600" title="Min">
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
          <div className="text-2xl font-bold text-gray-800">
            {latestReading?.ammonia != null ? Number(latestReading.ammonia).toFixed(2) : "--"}<span className="text-base font-normal text-gray-500"> ppm</span>
          </div>
        </div>
      </div>

      {/* Charts - Vertical layout for better readability */}
      {filteredHistory.length > 0 ? (
        <div className="space-y-3">
          <TrendCard
            title="Temperature (°C)"
            data={filteredHistory}
            dataKey="temperature"
            stroke="#f97316"
          />
          <TrendCard
            title="Water Level (%)"
            data={filteredHistory}
            dataKey="water_level"
            stroke="#2563eb"
          />
          <TrendCard
            title="Ammonia (ppm)"
            data={filteredHistory}
            dataKey="ammonia"
            stroke="#10b981"
          />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <History size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-600 font-medium">No data for selected time range</p>
          <p className="text-sm text-gray-400 mt-1">Try selecting a different time range.</p>
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
                        {new Date(day.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
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
