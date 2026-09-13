// =============================================================================
// src/pages/LogsPage.tsx
// Sensor/system parameter logs with filtering, action badges, and PDF export.
// =============================================================================

import { useState, useMemo, useCallback } from "react";
import {
  FileText,
  Download,
  Clock,
  Thermometer,
  Waves,
  FlaskConical,
  AlertTriangle,
  ArrowLeftRight,
  Activity,
  RefreshCw,
  Database,
  CheckCircle2,
} from "lucide-react";
import { useSensors } from "../hooks/useSensors";
import { useAuth } from "../contexts/useAuth";
import { Spinner, LoadingCard, ErrorCard } from "../components/Loading";
import { SENSOR_KEY_TO_DISPLAY } from "../types";
import { formatFarmDateTime, formatFarmDate, formatFarmTime } from "../utils/time";

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

const PARAMETER_ICONS: Record<string, React.ReactNode> = {
  Temperature: <Thermometer size={15} className="text-orange-500" />,
  "Water Level": <Waves size={15} className="text-blue-500" />,
  Ammonia: <FlaskConical size={15} className="text-emerald-500" />,
  temperature: <Thermometer size={15} className="text-orange-500" />,
  water_level: <Waves size={15} className="text-blue-500" />,
  ammonia: <FlaskConical size={15} className="text-emerald-500" />,
};

const ACTION_META: Record<string, { color: string; icon: typeof AlertTriangle }> = {
  Alert: { color: "bg-red-100 text-red-700", icon: AlertTriangle },
  Change: { color: "bg-orange-100 text-orange-700", icon: ArrowLeftRight },
  "Alert Resolved": { color: "bg-emerald-100 text-emerald-700", icon: CheckCircle2 },
};

const PARAMETERS = ["all", "Temperature", "Water Level", "Ammonia"] as const;

const titleCase = (s: string) =>
  String(s)
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

export default function LogsPage() {
  const { logs, logsLoading, logsError, refetchLogs, logsPage, logsTotal, setLogsPage, logsParameterFilter, setLogsParameterFilter, logsCounts, connectionStatus, lastUpdate } = useSensors();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [isChangingPage, setIsChangingPage] = useState(false);
  const [exporting, setExporting] = useState(false);

  const getDisplayParameter = (param: string): string => {
    return SENSOR_KEY_TO_DISPLAY[param] ?? param;
  };

  // Logs are filtered server-side by the active parameter filter.
  const filteredLogs = logs;

  const alertsTotal = logsCounts?.Alert ?? 0;
  const changesTotal = logsCounts?.Change ?? 0;
  const totalEntries = logsTotal || 0;

  const alertRate =
    totalEntries > 0 ? Math.round((alertsTotal / totalEntries) * 100) : 0;

  // Parameter breakdown for the currently loaded page.
  const paramCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of filteredLogs) {
      const label = getDisplayParameter(log.parameter);
      counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
  }, [filteredLogs]);

  const totalPages = useMemo(() => {
    const total = Number(logsTotal) || 0;
    return total > 0 ? Math.ceil(total / 20) : 1;
  }, [logsTotal]);

  const startItem = useMemo(() => ((logsPage - 1) * 20) + 1, [logsPage]);
  const endItem = useMemo(() => Math.min(logsPage * 20, logsTotal || 0), [logsPage, logsTotal]);

  const handlePageChange = useCallback(async (newPage: number) => {
    if (newPage < 1 || newPage > totalPages || newPage === logsPage || isChangingPage) return;
    setIsChangingPage(true);
    try {
      setLogsPage(newPage);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      setIsChangingPage(false);
    }
  }, [logsPage, totalPages, isChangingPage, setLogsPage]);

  const handleExport = useCallback(async () => {
    if (!isAdmin) return;
    if (filteredLogs.length === 0) {
      alert("No logs to export.");
      return;
    }

    setExporting(true);
    // Lazy-load jspdf (~150kB+) only when user actually exports.
    let jsPDFModule: typeof import("jspdf");
    let autoTableModule: typeof import("jspdf-autotable");
    try {
      [jsPDFModule, autoTableModule] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
    } catch {
      alert("Failed to load the PDF library. Please try again.");
      setExporting(false);
      return;
    }

    const { jsPDF } = jsPDFModule;
    const autoTable = autoTableModule.default;
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("CRAYvings System Logs", pageWidth / 2, 20, { align: "center" });

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Generated on ${formatFarmDateTime(new Date())}`, pageWidth / 2, 28, { align: "center" });

    const parameterCounts = filteredLogs.reduce<Record<string, number>>((acc, log) => {
      const displayParam = getDisplayParameter(log.parameter);
      if (["Temperature", "Water Level", "Ammonia"].includes(displayParam)) {
        acc[displayParam] = (acc[displayParam] || 0) + 1;
      }
      return acc;
    }, { Temperature: 0, "Water Level": 0, Ammonia: 0 });

    const summaryY = 34;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Summary", 14, summaryY);

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    let summaryLineY = summaryY + 6;
    doc.text(`Total Entries: ${filteredLogs.length}`, 14, summaryLineY);
    summaryLineY += 5;

    Object.entries(parameterCounts).forEach(([param, count]) => {
      doc.text(`${param}: ${count}`, 14, summaryLineY);
      summaryLineY += 5;
    });

    const tableStartY = summaryLineY + 8;

    const tableData = filteredLogs
      .filter((log) => {
        const displayParam = getDisplayParameter(log.parameter);
        return ["Temperature", "Water Level", "Ammonia"].includes(displayParam);
      })
      .map((log) => [
        log.timestamp ? formatFarmDateTime(log.timestamp) : "-",
        getDisplayParameter(log.parameter),
        String(log.old_value),
        String(log.new_value),
        log.action,
      ]);

    autoTable(doc, {
      startY: tableStartY,
      head: [["Timestamp", "Parameter", "Old Value", "New Value", "Action"]],
      body: tableData,
      styles: {
        fontSize: 8,
        cellPadding: 2.5,
        valign: "middle",
      },
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [30, 41, 59],
        fontStyle: "bold",
        halign: "center",
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252],
      },
      columnStyles: {
        0: { cellWidth: 45 },
        1: { cellWidth: 35 },
        2: { cellWidth: 30, halign: "center" },
        3: { cellWidth: 30, halign: "center" },
        4: { cellWidth: 35, halign: "center" },
      },
      margin: { left: 14, right: 14 },
    });

    // Stamp footers after table drawn so page total is accurate.
    const finalPageCount = doc.getNumberOfPages();
    for (let i = 1; i <= finalPageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(128, 128, 128);

      doc.text(
        `Page ${i} of ${finalPageCount}`,
        pageWidth / 2,
        pageHeight - 10,
        { align: "center" }
      );

      doc.text(
        "CRAYvings Monitoring System",
        14,
        pageHeight - 10
      );

      doc.text(
        `Exported: ${formatFarmDate(new Date())}`,
        pageWidth - 14,
        pageHeight - 10,
        { align: "right" }
      );
    }

    doc.save(`CRAYvings_System_Logs_${new Date().toISOString().split("T")[0]}.pdf`);
    setExporting(false);
  }, [filteredLogs, isAdmin]);

  if (logsLoading) {
    return <LoadingCard title="Sensor Logs" message="Loading logs..." />;
  }

  if (logsError) {
    return (
      <ErrorCard
        title="Failed to load logs"
        message="We couldn't load the sensor logs from the server. Please check your connection and try again."
        detail={logsError}
        onRetry={refetchLogs}
      />
    );
  }

  const isOnline = connectionStatus === "online";
  const isConnecting = connectionStatus === "connecting";

  const filterChips = (
    <div className="flex gap-2 flex-wrap">
      {PARAMETERS.map((param) => {
        const label = param === "all" ? "All Parameters" : param;
        const count =
          param === "all"
            ? null
            : paramCounts[param as string] ?? 0;
        return (
          <button
            key={param}
            onClick={() => setLogsParameterFilter(param === "all" ? "" : param)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              (param === "all" && logsParameterFilter === "") || logsParameterFilter === param
                ? "bg-orange-500 text-white shadow-sm"
                : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
            }`}
          >
            {param !== "all" && (PARAMETER_ICONS[param] ?? <Activity size={12} />)}
            {label}
            {count != null && (
              <span className={logsParameterFilter === param ? "text-white/80" : "text-gray-400"}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Hero banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#d94b1e] via-[#ef6a2e] to-amber-600 text-white shadow-sm">
        <div className="relative p-6 lg:p-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center shrink-0">
              <FileText size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                Sensor Logs
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-white/20 border border-white/30">
                  <span className={`w-2 h-2 rounded-full ${isConnecting ? "bg-yellow-300 animate-pulse" : isOnline ? "bg-green-300" : "bg-gray-200"}`} />
                  {isConnecting ? "Polling…" : isOnline ? "Live" : "Offline"}
                </span>
              </h1>
              <p className="text-white/80 text-sm mt-1">
                Threshold breaches and parameter changes from the sensors
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {lastUpdate && (
              <span className="flex items-center gap-1.5 text-white/90">
                <Clock size={14} /> Updated {formatFarmTime(lastUpdate)}
              </span>
            )}
            {isAdmin && (
              <button
                onClick={handleExport}
                disabled={exporting || filteredLogs.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-[#c2410c] text-sm font-semibold hover:bg-orange-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <Download size={14} />
                {exporting ? "Exporting…" : "Export PDF"}
              </button>
            )}
          </div>
        </div>
        <div className="px-6 lg:px-7 pb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/85">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
            {totalEntries.toLocaleString()} total entries
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
            {alertsTotal.toLocaleString()} alerts
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
            {changesTotal.toLocaleString()} changes
          </span>
        </div>
      </section>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Database size={12} /> Total Entries
          </div>
          <div className="text-2xl font-bold text-gray-800 mt-1">{totalEntries.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">across all parameters</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <AlertTriangle size={12} className="text-red-500" /> Alerts
          </div>
          <div className="text-2xl font-bold text-red-600 mt-1">{alertsTotal.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">threshold breaches</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <ArrowLeftRight size={12} className="text-orange-500" /> Changes
          </div>
          <div className="text-2xl font-bold text-orange-600 mt-1">{changesTotal.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">parameter updates</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Activity size={12} className="text-emerald-500" /> Alert Rate
          </div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{alertRate}%</div>
          <div className="text-[10px] text-gray-400">of all entries</div>
        </div>
      </div>

      {filteredLogs.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <FileText size={40} className="mx-auto mb-3 text-gray-300" />
          <h3 className="mt-0 text-gray-800">No logs found</h3>
          <p className="text-gray-600">Changes in system parameters will appear here</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-gray-100">
              {filterChips}
              <button
                onClick={refetchLogs}
                className="flex items-center gap-2 px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                <RefreshCw size={14} />
                Refresh
                {logsLoading && <Spinner size={12} />}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">
                      <Clock size={14} className="inline mr-1" />
                      Timestamp
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">
                      Parameter
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">
                      Change
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((log, index) => {
                    const meta = ACTION_META[log.action] ?? ACTION_META.Change!;
                    const Icon = meta.icon;
                    const displayParam = getDisplayParameter(log.parameter);
                    return (
                      <tr
                        key={log.id ?? index}
                        className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          <p className="text-xs font-medium text-gray-700">
                            {log.timestamp ? formatFarmDateTime(log.timestamp) : "-"}
                          </p>
                          <p className="text-[10px] text-gray-400">
                            {log.timestamp ? formatTimeAgo(log.timestamp) : ""}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-2">
                            <span className="w-8 h-8 rounded-lg bg-gray-50 border border-gray-200 flex items-center justify-center shrink-0">
                              {PARAMETER_ICONS[log.parameter] ?? PARAMETER_ICONS[displayParam] ?? (
                                <FileText size={14} className="text-gray-500" />
                              )}
                            </span>
                            <span className="text-sm font-semibold text-gray-800">
                              {displayParam}
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-2 flex-wrap">
                            <span className="px-2 py-1 rounded text-[11px] font-semibold bg-gray-100 text-gray-500 line-through">
                              {titleCase(String(log.old_value))}
                            </span>
                            <ArrowLeftRight size={12} className="text-gray-400" />
                            <span className={`px-2 py-1 rounded text-[11px] font-bold ${
                              log.action === "Alert" ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"
                            }`}>
                              {titleCase(String(log.new_value))}
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold ${meta.color}`}>
                            <Icon size={12} />
                            {titleCase(log.action)}
                            {log.action === "Alert" && (
                              <span className="text-[9px] font-bold uppercase opacity-70">outside</span>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400">
              Showing {startItem}-{endItem} of {logsTotal} logs
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => handlePageChange(logsPage - 1)}
                disabled={logsPage <= 1 || logsLoading || isChangingPage}
                className="px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 flex items-center gap-1"
              >
                Previous
              </button>
              <span className="px-3 py-1 text-sm text-gray-600 flex items-center gap-1.5">
                {isChangingPage && <Spinner size={12} />}
                Page {logsPage} of {totalPages}
              </span>
              <button
                onClick={() => handlePageChange(logsPage + 1)}
                disabled={logsPage >= totalPages || logsLoading || isChangingPage}
                className="px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 flex items-center gap-1"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}