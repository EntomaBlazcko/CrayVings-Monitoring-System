import { useCallback, useState } from "react";
import { Search, RefreshCw, ChevronLeft, ChevronRight, ArrowUpDown, Activity } from "lucide-react";
import { useActivityLogs } from "../hooks/useSensors";
import { ACTIVITY_ACTION_TYPES } from "../types";

const ACTION_TYPE_COLORS: Record<string, string> = {
  navigation: "bg-blue-100 text-blue-700",
  button_click: "bg-purple-100 text-purple-700",
  form_submit: "bg-indigo-100 text-indigo-700",
  settings_change: "bg-orange-100 text-orange-700",
  device_connect: "bg-green-100 text-green-700",
  device_disconnect: "bg-red-100 text-red-700",
  system_event: "bg-gray-100 text-gray-700",
  login: "bg-cyan-100 text-cyan-700",
  logout: "bg-slate-100 text-slate-700",
};

const ACTION_TYPE_ICONS: Record<string, React.ReactNode> = {
  navigation: "",
  button_click: "",
  form_submit: "",
  settings_change: "",
  device_connect: "",
  device_disconnect: "⏏",
  system_event: "",
  login: "",
  logout: "",
};

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

  const startItem = (activityLogsPage - 1) * 20 + 1;
  const endItem = Math.min(activityLogsPage * 20, activityLogsTotal);

  if (activityLogsLoading && activityLogs.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-gray-500">Loading activity logs...</div>
      </div>
    );
  }

  if (activityLogsError) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
        <p>{activityLogsError}</p>
        <button
          onClick={refetchActivityLogs}
          className="mt-2 px-3 py-1 bg-red-100 hover:bg-red-200 rounded text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="text-gray-600" size={20} />
          <h2 className="mt-0 text-gray-800">Activity Logs</h2>
        </div>
        <p className="text-gray-600 text-sm">
          Track all user interactions and system events
        </p>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <form onSubmit={handleSearchSubmit} className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search by action, user, or description..."
              className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </form>

        <select
          value={activityActionFilter}
          onChange={(e) => setActivityActionFilter(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Actions</option>
          {ACTIVITY_ACTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.replace("_", " ")}
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

        <button
          onClick={refetchActivityLogs}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

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
                  {activityLogs.map((log, index) => (
                    <tr
                      key={log.id ?? index}
                      className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                        {log.timestamp ? new Date(log.timestamp).toLocaleString() : "-"}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-800">
                        {log.user_name || "Admin"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_TYPE_COLORS[log.action_type] || "bg-gray-100 text-gray-700"}`}>
                          {ACTION_TYPE_ICONS[log.action_type] || "•"} {log.action_type.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-[300px] truncate">
                        {log.description}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {log.module || "-"}
                      </td>
                    </tr>
                  ))}
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
                onClick={() => setActivityLogsPage(Math.max(1, activityLogsPage - 1))}
                disabled={activityLogsPage <= 1}
                className="flex items-center gap-1 px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronLeft size={14} />
                Previous
              </button>
              <span className="px-3 py-1 text-sm text-gray-600">
                Page {activityLogsPage} of {activityLogsTotalPages || 1}
              </span>
              <button
                onClick={() => setActivityLogsPage(Math.min(activityLogsTotalPages, activityLogsPage + 1))}
                disabled={activityLogsPage >= activityLogsTotalPages}
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