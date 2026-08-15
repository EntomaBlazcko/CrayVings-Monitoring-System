// =============================================================================
// FILE: src/pages/AlertsPage.tsx
// =============================================================================
// PURPOSE: Alert history page showing system logs with severity classification.
//
// This page displays system logs (from the system_logs database table) with:
//   1. Filter buttons: All / Alert / Change
//   2. Severity-based color coding (critical=red, warning=orange, info=blue)
//   3. Alert count badges for each filter category
//   4. Pagination for browsing through log entries
//
// Each log entry shows:
//   - Action type badge (Alert or Change)
//   - Sensor parameter name
//   - Value that triggered the alert
//   - Timestamp
//
// DATA: System logs from SensorProvider (auto-polled every 5 seconds)
// =============================================================================

import { useMemo, useState } from "react";
import { AlertTriangle, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { useSensors } from "../hooks/useSensors";
import { Spinner, LoadingCard, ErrorCard } from "../components/Loading";
import { parseAlertSeverity, type AlertSeverity } from "../types";

export default function AlertsPage() {
  const { logs, settings, logsLoading, logsError, refetchLogs, logsPage, logsTotal, logsCounts, setLogsPage, logsActionFilter, setLogsActionFilter } = useSensors();
  const [isChangingPage, setIsChangingPage] = useState(false);

  const processedLogs = useMemo(() => {
    return logs.map((log) => ({
      ...log,
      severity: parseAlertSeverity(log, settings),
    }));
  }, [logs, settings]);

  const getSeverityColor = (severity?: AlertSeverity) => {
    switch (severity) {
      case "critical":
        return "bg-red-100 border-red-300 text-red-800";
      case "warning":
        return "bg-orange-100 border-orange-300 text-orange-800";
      case "info":
        return "bg-blue-100 border-blue-300 text-blue-800";
      default:
        return "bg-gray-100 border-gray-300 text-gray-800";
    }
  };

  const alertCounts = useMemo(
    () => ({
      all: Object.values(logsCounts || {}).reduce((sum, c) => sum + c, 0) || logs.length,
      Alert: logsCounts?.Alert ?? 0,
      Change: logsCounts?.Change ?? 0,
    }),
    [logs, logsCounts]
  );

  const logsTotalPages = useMemo(() => {
    return logsTotal ? Math.ceil(logsTotal / 20) : 1;
  }, [logsTotal]);

  const startItem = (logsPage - 1) * 20 + 1;
  const endItem = Math.min(logsPage * 20, logsTotal ?? logs.length);

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > logsTotalPages || newPage === logsPage || isChangingPage) return;
    setIsChangingPage(true);
    setLogsPage(newPage);
    // Brief pending window so the buttons stay disabled while the new page loads
    setTimeout(() => setIsChangingPage(false), 200);
  };

  if (logsLoading) {
    return <LoadingCard title="Alerts & Logs" message="Loading alerts..." />;
  }

  if (logsError) {
    return (
      <ErrorCard
        title="Failed to load alerts"
        message="We couldn't load the alerts from the server. Please check your connection and try again."
        detail={logsError}
        onRetry={refetchLogs}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="mt-0 text-gray-800 flex items-center gap-2">
              <AlertTriangle size={20} className="text-orange-500" />
              Alerts & Logs
            </h2>
            <p className="text-gray-600 text-sm mt-1">
              System alerts and change logs from sensor data
            </p>
          </div>
          <div className="text-sm text-gray-500">
            {logsTotal ?? logs.length} total entries
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["all", "Alert", "Change"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setLogsActionFilter(f === "all" ? "" : f)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              (f === "all" && logsActionFilter === "") || logsActionFilter === f
                ? "bg-orange-500 text-white"
                : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {f === "all" ? "All" : f} ({alertCounts[f]})
          </button>
        ))}
      </div>

      {processedLogs.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <AlertCircle size={40} className="mx-auto mb-3 text-green-500" />
          <h3 className="mt-0 text-gray-800">No Alerts</h3>
          <p className="text-gray-600">
            {logsActionFilter === "all" || logsActionFilter === ""
              ? "No alerts recorded yet. Alerts appear when sensors go outside thresholds."
              : `No ${logsActionFilter.toLowerCase()} alerts found.`}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {processedLogs.map((log, index) => (
              <div
                key={log.id ?? index}
                className={`rounded-lg border p-3 ${getSeverityColor(log.severity)}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-bold ${
                        log.action === "Alert"
                          ? "bg-red-500 text-white"
                          : log.action === "Change"
                            ? "bg-blue-500 text-white"
                            : "bg-gray-500 text-white"
                      }`}
                    >
                      {log.action}
                    </span>
                    <span className="font-semibold text-sm">{log.parameter}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    {log.timestamp
                      ? new Date(log.timestamp).toLocaleString()
                      : "N/A"}
                  </div>
                </div>

                <div className="mt-2 text-sm">
                  {log.action === "Alert" ? (
                    <span>
                      <span className="font-medium">{log.parameter}</span> is{" "}
                      <span className="font-bold">{String(log.new_value)}</span>
                      {log.old_value && (
                        <span> (recorded: <span className="font-bold">{log.old_value}</span>)</span>
                      )}
                    </span>
                  ) : (
                    <span>
                      Changed from <span className="font-bold">{log.old_value}</span> to{" "}
                      <span className="font-bold">{log.new_value}</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {logsTotal > 20 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">
                Showing {startItem}-{endItem} of {logsTotal} logs
              </p>
              <div className="flex gap-1 items-center">
                <button
                  onClick={() => handlePageChange(logsPage - 1)}
                  disabled={logsPage <= 1 || isChangingPage}
                  className="flex items-center gap-1 px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  <ChevronLeft size={14} />
                  Previous
                </button>
                <span className="px-3 py-1 text-sm text-gray-600 flex items-center gap-1.5">
                  {isChangingPage && <Spinner size={12} />}
                  Page {logsPage} of {logsTotalPages}
                </span>
                <button
                  onClick={() => handlePageChange(logsPage + 1)}
                  disabled={logsPage >= logsTotalPages || isChangingPage}
                  className="flex items-center gap-1 px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
