// =============================================================================
// src/pages/ActivityLogsPage.tsx
// User activity logs with search, filter, sort, action breakdown, and pagination.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Activity,
  Map,
  MousePointerClick,
  Send,
  Settings,
  Cable,
  Unplug,
  Cpu,
  LogIn,
  Users,
  FileText,
  Clock,
  ListFilter,
} from "lucide-react";
import { useActivityLogs } from "../hooks/useSensors";
import { Spinner, LoadingCard, ErrorCard } from "../components/Loading";
import { formatFarmDateTime, formatFarmTime } from "../utils/time";

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

const ACTION_META: Record<string, { color: string; icon: typeof Map }> = {
  navigation: { color: "bg-orange-100 text-orange-700", icon: Map },
  button_click: { color: "bg-amber-100 text-amber-700", icon: MousePointerClick },
  form_submit: { color: "bg-yellow-100 text-yellow-700", icon: Send },
  settings_change: { color: "bg-orange-200 text-orange-900", icon: Settings },
  device_connect: { color: "bg-green-100 text-green-700", icon: Cable },
  device_disconnect: { color: "bg-red-100 text-red-700", icon: Unplug },
  system_event: { color: "bg-gray-100 text-gray-700", icon: Cpu },
  login: { color: "bg-amber-200 text-amber-900", icon: LogIn },
};

const FILTER_ACTION_TYPES = ["navigation", "settings_change", "device_connect", "device_disconnect"];

const titleCase = (s: string) =>
  String(s)
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

export default function ActivityLogsPage() {
  const {
    activityLogs,
    activityLogsLoading,
    activityLogsError,
    activityLogsPage,
    activityLogsTotal,
    activityLogsTotalPages,
    activitySearch,
    activitySortBy,
    activityActionFilter,
    setActivityLogsPage,
    setActivitySearch,
    setActivitySortBy,
    setActivityActionFilter,
    refetchActivityLogs,
  } = useActivityLogs();

  const [searchInput, setSearchInput] = useState(activitySearch);
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [isChangingPage, setIsChangingPage] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  useEffect(() => {
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [debounceTimer]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (debounceTimer) clearTimeout(debounceTimer);
    const timer = setTimeout(() => {
      setActivitySearch(value);
    }, 300);
    setDebounceTimer(timer);
  }, [setActivitySearch, debounceTimer]);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (debounceTimer) clearTimeout(debounceTimer);
    setActivitySearch(searchInput);
  }, [setActivitySearch, searchInput, debounceTimer]);

  const handleSortChange = useCallback(() => {
    setActivitySortBy(activitySortBy === "newest" ? "oldest" : "newest");
  }, [setActivitySortBy, activitySortBy]);

  const handlePageChange = useCallback(async (newPage: number) => {
    const totalPages = activityLogsTotalPages || 1;
    if (newPage < 1 || newPage > totalPages || newPage === activityLogsPage || isChangingPage) return;
    setIsChangingPage(true);
    try {
      setActivityLogsPage(newPage);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      setIsChangingPage(false);
    }
  }, [activityLogsPage, activityLogsTotalPages, isChangingPage, setActivityLogsPage]);

  const handleRefresh = useCallback(() => {
    refetchActivityLogs();
    setLastRefreshed(new Date());
  }, [refetchActivityLogs]);

  const startItem = (activityLogsPage - 1) * 20 + 1;
  const endItem = Math.min(activityLogsPage * 20, activityLogsTotal);

  // Per-action breakdown for the currently loaded page.
  const actionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of activityLogs) {
      const type = log.action_type || "unknown";
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }, [activityLogs]);

  const distinctUsers = useMemo(
    () => new Set(activityLogs.map((l) => l.user_name).filter(Boolean)).size,
    [activityLogs]
  );

  const settingsChanges = actionCounts["settings_change"] ?? 0;
  const connectEvents = (actionCounts["device_connect"] ?? 0) + (actionCounts["device_disconnect"] ?? 0);

  if (activityLogsLoading && activityLogs.length === 0) {
    return <LoadingCard title="Activity Logs" message="Loading activity logs..." />;
  }

  if (activityLogsError) {
    return (
      <ErrorCard
        title="Failed to load activity logs"
        message="We couldn't load the activity logs from the server. Please check your connection and try again."
        detail={activityLogsError}
        onRetry={refetchActivityLogs}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Hero banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#d94b1e] via-[#ef6a2e] to-amber-600 text-white shadow-sm">
        <div className="relative p-6 lg:p-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center shrink-0">
              <Activity size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                Activity Logs
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-white/20 border border-white/30">
                  <span className="w-2 h-2 rounded-full bg-emerald-300" />
                  Tracking
                </span>
              </h1>
              <p className="text-white/80 text-sm mt-1">
                User interactions and system events across the farm
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1.5 text-white/90">
              <Clock size={14} /> Updated {formatFarmTime(lastRefreshed)}
            </span>
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-slate-700 text-sm font-semibold hover:bg-slate-50 transition"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>
        <div className="px-6 lg:px-7 pb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/85">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
            {activityLogsTotal.toLocaleString()} total entries
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10">
            {distinctUsers} user{distinctUsers === 1 ? "" : "s"} this page
          </span>
        </div>
      </section>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <FileText size={12} /> Total Entries
          </div>
          <div className="text-2xl font-bold text-gray-800 mt-1">{activityLogsTotal.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">across all activity types</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Users size={12} className="text-orange-500" /> Users (this page)
          </div>
          <div className="text-2xl font-bold text-orange-600 mt-1">{distinctUsers}</div>
          <div className="text-[10px] text-gray-400">distinct accounts</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Settings size={12} className="text-orange-500" /> Settings Changes
          </div>
          <div className="text-2xl font-bold text-orange-600 mt-1">{settingsChanges}</div>
          <div className="text-[10px] text-gray-400">on current page</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Cable size={12} className="text-green-500" /> Connect Events
          </div>
          <div className="text-2xl font-bold text-green-600 mt-1">{connectEvents}</div>
          <div className="text-[10px] text-gray-400">on current page</div>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap gap-3 items-center">
        <form onSubmit={handleSearchSubmit} className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search by action, user, or description..."
              className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </form>

        <select
          value={activityActionFilter}
          onChange={(e) => setActivityActionFilter(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        >
          <option value="">All Actions</option>
          {FILTER_ACTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {titleCase(type)}
            </option>
          ))}
        </select>

        <button
          onClick={handleSortChange}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50"
        >
          <ArrowUpDown size={14} />
          {activitySortBy === "newest" ? "Newest First" : "Oldest First"}
        </button>
      </div>

      {/* Action type breakdown chips */}
      {Object.keys(actionCounts).length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
            <ListFilter size={12} /> This page:
          </span>
          {Object.entries(actionCounts).map(([type, count]) => {
            const meta = ACTION_META[type] ?? ACTION_META.system_event!;
            const Icon = meta.icon;
            const active = activityActionFilter === type;
            return (
              <button
                key={type}
                onClick={() => setActivityActionFilter(active ? "" : type)}
                title={active ? "Clear filter" : `Filter by ${titleCase(type)}`}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                  active
                    ? "bg-slate-800 text-white border-slate-800"
                    : `${meta.color} border-transparent hover:border-gray-200`
                }`}
              >
                <Icon size={12} />
                {titleCase(type)}: {count}
              </button>
            );
          })}
        </div>
      )}

      {activityLogs.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <Activity size={40} className="mx-auto mb-3 text-gray-400" />
          <h3 className="mt-0 text-gray-800">No Activity Logs</h3>
          <p className="text-gray-600">
            {activitySearch || activityActionFilter
              ? "No logs match your search criteria."
              : "User activities will appear here."}
          </p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">Time</th>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">User</th>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">Action</th>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">Description</th>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">Module</th>
                  </tr>
                </thead>
                <tbody>
                  {activityLogs.map((log, index) => {
                    const meta = ACTION_META[log.action_type] ?? ACTION_META.system_event!;
                    const Icon = meta.icon;
                    const userName = (log.user_name || "Admin")
                      .split(/[\s_]+/)
                      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(" ");
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
                            <span className="w-7 h-7 rounded-full bg-slate-100 border border-gray-200 text-slate-600 text-xs font-bold flex items-center justify-center shrink-0">
                              {userName.charAt(0)}
                            </span>
                            <span className="text-sm font-medium text-gray-800">{userName}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold ${meta.color}`}>
                            <Icon size={12} />
                            {titleCase(log.action_type)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 max-w-[300px]">
                          <span className="block truncate" title={log.description}>
                            {log.description}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {log.module ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 text-gray-600 text-xs font-medium">
                              <Map size={10} className="opacity-60" />
                              {log.module}
                            </span>
                          ) : (
                            "-"
                          )}
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
              Showing {startItem}-{endItem} of {activityLogsTotal} logs
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => handlePageChange(activityLogsPage - 1)}
                disabled={activityLogsPage <= 1 || activityLogsLoading || isChangingPage}
                className="flex items-center gap-1 px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronLeft size={14} />
                Previous
              </button>
              <span className="px-3 py-1 text-sm text-gray-600 flex items-center gap-1.5">
                {isChangingPage && <Spinner size={12} />}
                Page {activityLogsPage} of {activityLogsTotalPages || 1}
              </span>
              <button
                onClick={() => handlePageChange(activityLogsPage + 1)}
                disabled={activityLogsPage >= (activityLogsTotalPages || 1) || activityLogsLoading || isChangingPage}
                className="flex items-center gap-1 px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}