// =============================================================================
// src/pages/AlertsPage.tsx
// Alert history with severity classification, action/severity filters,
// parameter breakdown, and pagination.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  AlertTriangle,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Thermometer,
  Waves,
  FlaskConical,
  Activity,
  RefreshCw,
  Clock,
  ShieldAlert,
  CheckCircle2,
  Wrench,
  ThumbsUp,
  X,
  Settings2,
} from "lucide-react";
import { useSensors } from "../hooks/useSensors";
import { useActivityLogger } from "../hooks/useSensors";
import { useAuth } from "../contexts/useAuth";
import { Spinner, LoadingCard, ErrorCard } from "../components/Loading";
import { parseAlertSeverity, type AlertSeverity } from "../types";
import { SENSOR_KEY_TO_DISPLAY, DISPLAY_TO_SENSOR_KEY } from "../types";
import type { LogEntry, MenuKey } from "../types";
import { formatFarmDateTime, formatFarmTime } from "../utils/time";
import { buildScenarioGuidance, getAlertGuidance } from "../utils/alertGuidance";
import type { AlertGuidance } from "../utils/alertGuidance";
import { FixLegendPanel, FixLegendModal } from "../components/FixLegend";
import { acknowledgeLog } from "../api/client";

type SeverityFilter = AlertSeverity | "";

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

const SEVERITY_META: Record<AlertSeverity, { bar: string; pill: string; label: string; icon: React.ReactNode }> = {
  critical: {
    bar: "border-l-red-500",
    pill: "bg-red-100 text-red-700",
    label: "Critical",
    icon: <AlertTriangle size={14} />,
  },
  warning: {
    bar: "border-l-amber-500",
    pill: "bg-amber-100 text-amber-700",
    label: "Warning",
    icon: <AlertTriangle size={14} />,
  },
  info: {
    bar: "border-l-orange-500",
    pill: "bg-orange-100 text-orange-700",
    label: "Info",
    icon: <AlertCircle size={14} />,
  },
};

const PARAM_ICON: Record<string, React.ReactNode> = {
  Temperature: <Thermometer size={16} className="text-orange-500" />,
  "Water Level": <Waves size={16} className="text-blue-500" />,
  Ammonia: <FlaskConical size={16} className="text-emerald-500" />,
  temperature: <Thermometer size={16} className="text-orange-500" />,
  water_level: <Waves size={16} className="text-blue-500" />,
  ammonia: <FlaskConical size={16} className="text-emerald-500" />,
};

type AckStatus = "confirmed" | "allowed";

type AcknowledgeInfo = {
  status: AckStatus;
  by?: string;
  at?: string;
};

export default function AlertsPage({ onNavigate }: { onNavigate?: (menu: MenuKey) => void }) {
  const {
    logs,
    settings,
    logsLoading,
    logsError,
    refetchLogs,
    logsPage,
    logsTotal,
    logsCounts,
    setLogsPage,
    logsActionFilter,
    setLogsActionFilter,
    connectionStatus,
    lastUpdate,
  } = useSensors();
  const logActivity = useActivityLogger();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [isChangingPage, setIsChangingPage] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<LogEntry | null>(null);
  const [legendGuidance, setLegendGuidance] = useState<AlertGuidance | null>(null);
  const [acknowledgements, setAcknowledgements] = useState<Record<string, AcknowledgeInfo>>({});
  const [ackInFlight, setAckInFlight] = useState(false);

  // Acknowledgement state lives on each alert row in the DB (ack_status). Seed the
  // local map from the server so badges survive reloads; optimistic updates keep
  // the UI responsive between clicks and the next poll.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcknowledgements((prev) => {
      const next = { ...prev };
      for (const entry of logs) {
        if (!entry.ack_status) continue;
        next[String(entry.id)] = {
          status: entry.ack_status === "confirmed" ? "confirmed" : "allowed",
          by: entry.acknowledged_by ?? undefined,
          at: entry.acknowledged_at ?? undefined,
        };
      }
      return next;
    });
  }, [logs]);

  // Close the guidance modal with Escape.
  useEffect(() => {
    if (!selectedAlert) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedAlert(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedAlert]);

  const processedLogs = useMemo(() => {
    return logs.map((log) => ({
      ...log,
      severity: parseAlertSeverity(log, settings),
    }));
  }, [logs, settings]);

  // Client-side severity filtering of the currently loaded (action-filtered) page.
  const filteredLogs = useMemo(() => {
    if (!severityFilter) return processedLogs;
    return processedLogs.filter((log) => log.severity === severityFilter);
  }, [processedLogs, severityFilter]);

  const severityCounts = useMemo(
    () => ({
      critical: processedLogs.filter((l) => l.severity === "critical").length,
      warning: processedLogs.filter((l) => l.severity === "warning").length,
      info: processedLogs.filter((l) => l.severity === "info").length,
    }),
    [processedLogs]
  );

  const paramCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of processedLogs.filter((l) => l.severity !== "info")) {
      const label = SENSOR_KEY_TO_DISPLAY[log.parameter] ?? log.parameter;
      counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
  }, [processedLogs]);

  const activeAlerts = logsCounts?.Alert ?? 0;
  const activeChanges = logsCounts?.Change ?? 0;
  const totalEntries = logsTotal ?? logs.length;

  const alertCounts = useMemo(
    () => ({
      all: totalEntries,
      Alert: activeAlerts,
      Change: activeChanges,
    }),
    [totalEntries, activeAlerts, activeChanges]
  );

  const logsTotalPages = useMemo(() => (logsTotal ? Math.ceil(logsTotal / 20) : 1), [logsTotal]);

  const startItem = (logsPage - 1) * 20 + 1;
  const endItem = Math.min(logsPage * 20, totalEntries);

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > logsTotalPages || newPage === logsPage || isChangingPage) return;
    setIsChangingPage(true);
    setLogsPage(newPage);
    setTimeout(() => setIsChangingPage(false), 200);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refetchLogs();
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  };

  // Each alert is acknowledged individually: the server stores the status on the
  // row itself (ack_status), so the badge maps 1:1 to the alert it came from.
  const isAcked = (log: LogEntry): AcknowledgeInfo | undefined =>
    log.id != null ? acknowledgements[String(log.id)] : undefined;

  const handleAcknowledge = async (log: LogEntry, kind: AckStatus) => {
    if (ackInFlight || log.id == null || isAcked(log)) return;
    setAckInFlight(true);
    try {
      const updated = await acknowledgeLog(log.id, kind);
      setAcknowledgements((prev) => ({
        ...prev,
        [String(log.id)]: {
          status: kind,
          by: updated.acknowledged_by ?? undefined,
          at: updated.acknowledged_at ?? undefined,
        },
      }));
      const displayParam = SENSOR_KEY_TO_DISPLAY[log.parameter] ?? log.parameter;
      logActivity(
        "button_click",
        `${kind === "confirmed" ? "Confirmed" : "Allowed"} fix for ${displayParam} ${String(log.old_value ?? "")} alert`,
        "Alerts"
      );
    } catch {
      // Non-blocking: keep the UI usable if the acknowledgement fails.
    } finally {
      setAckInFlight(false);
    }
  };

  // Opens the shared fix guidance modal for a legend scenario (no specific log).
  const handleLegendFix = (scenarioKey: string) => {
    const guidance = buildScenarioGuidance(scenarioKey, settings);
    if (guidance) setLegendGuidance(guidance);
  };

  // Per-scenario alert counts (current loaded page) for the legend panel.
  const scenarioCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of logs) {
      if (log.action !== "Alert") continue;
      const logKey = `${log.parameter}:${String(log.old_value ?? "")}`;
      counts[logKey] = (counts[logKey] || 0) + 1;
    }
    return counts;
  }, [logs]);

  const isOnline = connectionStatus === "online";
  const isConnecting = connectionStatus === "connecting";

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

  const actionFilters: { value: keyof typeof alertCounts; label: string }[] = [
    { value: "all", label: "All Entries" },
    { value: "Alert", label: "Alerts" },
    { value: "Change", label: "Changes" },
  ];

  return (
    <>
      <div className="space-y-4">
      {/* Hero banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-orange-500 via-red-500 to-red-700 text-white shadow-sm">
        <div className="relative p-6 lg:p-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/20 border border-white/30 flex items-center justify-center">
              <Bell size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                Alerts & Logs
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-white/20 border border-white/30">
                  <span className={`w-2 h-2 rounded-full ${isConnecting ? "bg-yellow-300 animate-pulse" : isOnline ? "bg-emerald-300" : "bg-gray-200"}`} />
                  {isConnecting ? "Polling…" : isOnline ? "Live" : "Offline"}
                </span>
              </h1>
              <p className="text-white/80 text-sm mt-1">
                Sensor threshold alerts and configuration change events
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {lastUpdate && (
              <span className="flex items-center gap-1.5 text-white/90">
                <Clock size={14} /> Updated {formatFarmTime(lastUpdate)}
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-red-600 text-sm font-semibold hover:bg-orange-50 disabled:opacity-50 transition"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </section>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Bell size={12} /> Total Entries
          </div>
          <div className="text-2xl font-bold text-gray-800 mt-1">{totalEntries.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">across all action types</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <AlertTriangle size={12} className="text-red-500" /> Alerts
          </div>
          <div className="text-2xl font-bold text-red-600 mt-1">{activeAlerts.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">threshold breaches</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <ShieldAlert size={12} className="text-red-500" /> Critical (page)
          </div>
          <div className="text-2xl font-bold text-red-600 mt-1">{severityCounts.critical}</div>
          <div className="text-[10px] text-gray-400">on current page</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Activity size={12} className="text-orange-500" /> Changes
          </div>
          <div className="text-2xl font-bold text-orange-600 mt-1">{activeChanges.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">threshold settings updated</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">Type</span>
          {actionFilters.map((f) => (
            <button
              key={f.value}
              onClick={() => setLogsActionFilter(f.value === "all" ? "" : f.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                logsActionFilter === (f.value === "all" ? "" : f.value)
                  ? "bg-orange-500 text-white shadow-sm"
                  : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {f.label} ({alertCounts[f.value]})
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">Severity</span>
          {([["", "All"], ["critical", "Critical"], ["warning", "Warning"], ["info", "Info"]] as [SeverityFilter, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setSeverityFilter(val)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                severityFilter === val
                  ? "bg-gray-800 text-white shadow-sm"
                  : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {label}{" "}
              <span className={severityFilter === val ? "text-white/70" : "text-gray-400"}>
                ({val === "" ? processedLogs.length : severityCounts[val]})
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Fix Legend */}
      <FixLegendPanel counts={scenarioCounts} onOpenFix={handleLegendFix} />

      {/* Parameter breakdown */}
      {Object.keys(paramCounts).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(paramCounts).map(([param, count]) => (
            <span key={param} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-50 border border-gray-200 text-gray-600">
              {PARAM_ICON[param] ?? <Activity size={12} className="text-gray-400" />}
              {param}: {count}
            </span>
          ))}
        </div>
      )}

      {filteredLogs.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3 text-green-500" />
          <h3 className="mt-0 text-gray-800">No Alerts</h3>
          <p className="text-gray-600">
            {severityFilter ? `No ${severityFilter} entries on this page.` : "No alerts recorded yet. Alerts appear when sensors go outside thresholds."}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {filteredLogs.map((log, index) => {
              const severity = log.severity ?? "info";
              const meta = SEVERITY_META[severity];
              const displayParam = SENSOR_KEY_TO_DISPLAY[log.parameter] ?? log.parameter;
              const paramIcon = PARAM_ICON[log.parameter] ?? PARAM_ICON[displayParam] ?? <Activity size={16} className="text-gray-400" />;
              const titleCase = (s: string) =>
                String(s)
                  .split(/[\s_]+/)
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join(" ");

              return (
                <div
                  key={log.id ?? index}
                  onClick={log.action === "Alert" ? () => setSelectedAlert(log) : undefined}
                  className={`rounded-lg border border-l-4 border-gray-200 bg-white p-3.5 shadow-sm transition ${meta.bar} ${log.action === "Alert" ? "cursor-pointer hover:shadow-md" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center shrink-0">
                        {paramIcon}
                      </span>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-bold ${
                              log.action === "Alert" ? "bg-red-500 text-white" : log.action === "Change" ? "bg-orange-600 text-white" : "bg-gray-500 text-white"
                            }`}
                          >
                            {titleCase(log.action)}
                          </span>
                          <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${meta.pill}`}>
                            {meta.icon} {meta.label}
                          </span>
                          {log.action === "Alert" && isAcked(log) && (
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                                isAcked(log)?.status === "confirmed" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"
                              }`}
                            >
                              {isAcked(log)?.status === "confirmed" ? <CheckCircle2 size={10} /> : <ThumbsUp size={10} />}
                              {isAcked(log)?.status === "confirmed" ? "Confirmed" : "Allowed"}
                            </span>
                          )}
                        </div>
                        <p className="font-semibold text-sm text-gray-800 mt-0.5">{displayParam}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-medium text-gray-500">
                        {log.timestamp ? formatFarmDateTime(log.timestamp) : "N/A"}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        {formatTimeAgo(log.timestamp ?? "")}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2 text-sm text-gray-700">
                    {log.action === "Alert" ? (
                      <span>
                        {displayParam} is{" "}
                        <span className="font-bold text-red-600">{titleCase(String(log.old_value ?? "out of range"))}</span>
                        {String(log.new_value) !== "" && log.new_value != null && (
                          <span className="text-gray-500">
                            {" "}(recorded:{" "}
                            <span className="font-bold">{String(log.new_value)}</span>
                            {(() => {
                              const unitKey = DISPLAY_TO_SENSOR_KEY[log.parameter];
                              return unitKey === "temperature" ? "°C" : unitKey === "water_level" ? "%" : unitKey === "ammonia" ? " ppm" : "";
                            })()}
                            )
                          </span>
                        )}
                      </span>
                    ) : (
                      <span>
                        Changed from <span className="font-bold">{titleCase(String(log.old_value))}</span> to{" "}
                        <span className="font-bold">{titleCase(String(log.new_value))}</span>
                      </span>
                    )}
                  </div>

                  {log.action === "Alert" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedAlert(log);
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-50 text-[#c2410c] border border-orange-200 hover:bg-orange-100 transition"
                      >
                        <Wrench size={13} />
                        How to fix
                      </button>
                      {isAcked(log) ? (
                        <span className="text-[11px] text-gray-400">
                          {isAcked(log)?.status === "confirmed" ? "Fix marked as done" : "Fix approved — no action taken yet"}
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAcknowledge(log, "confirmed");
                            }}
                            disabled={ackInFlight}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition"
                          >
                            <CheckCircle2 size={13} />
                            Confirm
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAcknowledge(log, "allowed");
                            }}
                            disabled={ackInFlight}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 disabled:opacity-50 transition"
                          >
                            <ThumbsUp size={13} />
                            Allow
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {totalEntries > 20 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">
                Showing {startItem}-{endItem} of {totalEntries} entries
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

      {selectedAlert &&
        (() => {
        const guidance = getAlertGuidance(selectedAlert, settings);
        if (!guidance) return null;
        const severity = guidance.severity;
        const meta = SEVERITY_META[severity];
        const acked = isAcked(selectedAlert);
        const displayParam = SENSOR_KEY_TO_DISPLAY[selectedAlert.parameter] ?? selectedAlert.parameter;

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={() => setSelectedAlert(null)}
          >
            <div
              className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden max-h-[90vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={`How to fix ${displayParam} alert`}
            >
              <div className="flex items-start justify-between gap-3 p-4 bg-gray-50 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  {PARAM_ICON[selectedAlert.parameter] ?? PARAM_ICON[displayParam]}
                  <div>
                    <h3 className="font-bold text-gray-800 leading-tight">{guidance.name}</h3>
                    <p className="text-[10px] text-gray-400">{guidance.direction} — {guidance.unit}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold ${meta.pill}`}>
                    {meta.icon} {meta.label}
                  </span>
                  <button
                    onClick={() => setSelectedAlert(null)}
                    className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-4 overflow-y-auto">
                {selectedAlert.timestamp && (
                  <p className="text-[11px] text-gray-400">Occurred {formatFarmDateTime(selectedAlert.timestamp)}</p>
                )}

                <div>
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">What's happening</p>
                  <p className="text-sm text-gray-700">{guidance.diagnosis}</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-gray-50 border border-gray-100 p-2.5">
                    <p className="text-[10px] font-bold text-gray-400 uppercase">Reading</p>
                    <p className="text-lg font-bold text-gray-800">
                      {guidance.currentValue != null ? `${guidance.currentValue} ${guidance.unit}` : "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 border border-gray-100 p-2.5">
                    <p className="text-[10px] font-bold text-gray-400 uppercase">Safe range</p>
                    <p className="text-lg font-bold text-gray-800">
                      {guidance.safeRange.min} – {guidance.safeRange.max} {guidance.unit}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">Suggested fixes</p>
                  <ol className="space-y-1.5 text-sm text-gray-700">
                    {guidance.fixes.map((fix, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-700 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                          {i + 1}
                        </span>
                        <span>{fix}</span>
                      </li>
                    ))}
                  </ol>
                  {guidance.preventionTip && (
                    <p className="mt-2 text-xs text-emerald-700">
                      <span className="font-bold">Prevention tip:</span> {guidance.preventionTip}
                    </p>
                  )}
                </div>
              </div>

              <div className="p-4 border-t border-gray-100 flex flex-wrap items-center gap-2">
                {isAdmin && (
                  <button
                    onClick={() => {
                      setSelectedAlert(null);
                      onNavigate?.("Settings");
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 transition"
                  >
                    <Settings2 size={13} />
                    Adjust thresholds
                  </button>
                )}
                {acked ? (
                  <div className="ml-auto flex flex-col items-end gap-0.5">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500">
                      <CheckCircle2 size={13} className={acked.status === "confirmed" ? "text-emerald-500" : "text-gray-400"} />
                      {acked.status === "confirmed" ? "Fix confirmed as done" : "Fix allowed / approved"}
                    </span>
                    {(acked.by || acked.at) && (
                      <span className="text-[10px] text-gray-400">
                        {[acked.by, acked.at ? formatFarmDateTime(acked.at) : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => handleAcknowledge(selectedAlert, "allowed")}
                      disabled={ackInFlight}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 disabled:opacity-50 transition"
                    >
                      <ThumbsUp size={13} />
                      Allow
                    </button>
                    <button
                      onClick={() => handleAcknowledge(selectedAlert, "confirmed")}
                      disabled={ackInFlight}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition"
                    >
                      <CheckCircle2 size={13} />
                      Confirm
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Fix guidance modal (opened from the Fix Legend panel) */}
      {legendGuidance && (
        <FixLegendModal
          guidance={legendGuidance}
          onClose={() => setLegendGuidance(null)}
          onAdjustThresholds={isAdmin ? () => { setLegendGuidance(null); onNavigate?.("Settings"); } : undefined}
        />
      )}
    </>
  );
}