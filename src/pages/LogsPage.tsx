import { useState, useMemo, useCallback } from "react";
import { FileText, Download, Clock, Thermometer, Droplets, Waves, FlaskConical, AlertCircle } from "lucide-react";
import { useSensors } from "../hooks/useSensors";

const PARAMETER_ICONS: Record<string, React.ReactNode> = {
  Temperature: <Thermometer size={14} className="text-blue-500" />,
  "pH Level": <FlaskConical size={14} className="text-emerald-500" />,
  "Water Level": <Waves size={14} className="text-indigo-500" />,
  "Dissolved Oxygen": <Droplets size={14} className="text-sky-500" />,
  Ammonia: <AlertCircle size={14} className="text-orange-500" />,
};

const PARAMETERS = ["all", "Temperature", "pH Level", "Water Level", "Dissolved Oxygen", "Ammonia"] as const;
type ParameterFilter = typeof PARAMETERS[number];

export default function LogsPage() {
  const { logs, logsLoading, logsError, refetchLogs, logsPage, logsTotal, setLogsPage } = useSensors();
  const [filter, setFilter] = useState<ParameterFilter>("all");

  const filteredLogs = useMemo(
    () => (filter === "all" ? logs : logs.filter((log) => log.parameter === filter)),
    [logs, filter]
  );

  const totalPages = useMemo(() => Math.ceil(logsTotal / 20), [logsTotal]);
  const startItem = useMemo(() => ((logsPage - 1) * 20) + 1, [logsPage]);
  const endItem = useMemo(() => Math.min(logsPage * 20, logsTotal), [logsPage, logsTotal]);

  const handleExport = useCallback(() => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>CRAYvings System Logs - ${new Date().toLocaleDateString()}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            h1 { color: #1e293b; margin-bottom: 5px; }
            .date { color: #64748b; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #e2e8f0; padding: 10px; text-align: left; }
            th { background: #f1f5f9; }
            @media print { body { margin: 0; } }
          </style>
        </head>
        <body>
          <h1>CRAYvings System Logs</h1>
          <p class="date">Generated on ${new Date().toLocaleString()}</p>
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Parameter</th>
                <th>Old Value</th>
                <th>New Value</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${filteredLogs
                .map(
                  (log) => `
                <tr>
                  <td>${log.timestamp ? new Date(log.timestamp).toLocaleString() : "-"}</td>
                  <td>${log.parameter}</td>
                  <td>${log.old_value}</td>
                  <td>${log.new_value}</td>
                  <td>${log.action}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 250);
  }, [filteredLogs]);

  if (logsLoading) {
    return (
      <div className="bg-blue-50 border border-blue-200 text-blue-700 rounded-lg p-3 text-sm">
        Loading logs...
      </div>
    );
  }

  if (logsError) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
        <p>Failed to load logs</p>
        <p className="text-sm mt-1">{logsError}</p>
        <button
          onClick={refetchLogs}
          className="mt-2 px-3 py-1 bg-red-100 hover:bg-red-200 rounded text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  if (filteredLogs.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2 flex-wrap">
            {PARAMETERS.map((param) => (
              <button
                key={param}
                onClick={() => setFilter(param)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  filter === param
                    ? "bg-[#c2410c] text-white"
                    : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
                }`}
              >
                {param === "all" ? "All" : param}
              </button>
            ))}
          </div>
        </div>
        <div className="bg-gray-50 border border-gray-200 text-gray-600 rounded-lg p-8 text-center">
          <FileText size={32} className="mx-auto mb-2 text-gray-400" />
          <p className="font-semibold">No logs found</p>
          <p className="text-sm">Changes in system parameters will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2 flex-wrap">
          {PARAMETERS.map((param) => (
            <button
              key={param}
              onClick={() => setFilter(param)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                filter === param
                  ? "bg-[#c2410c] text-white"
                  : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
              }`}
            >
              {param === "all" ? "All" : param}
            </button>
          ))}
        </div>

        <button
          onClick={handleExport}
          className="flex items-center gap-2 rounded-lg bg-[#c2410c] px-4 py-2 text-sm font-semibold text-white hover:bg-[#a13a0a]"
        >
          <Download size={16} />
          Export PDF
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
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
                  Old Value
                </th>
                <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">
                  New Value
                </th>
                <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log, index) => (
                <tr
                  key={log.id ?? index}
                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                >
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {log.timestamp
                      ? new Date(log.timestamp).toLocaleString()
                      : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {PARAMETER_ICONS[log.parameter] ?? (
                        <FileText size={14} className="text-gray-500" />
                      )}
                      <span className="text-sm font-medium text-gray-800">
                        {log.parameter}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {log.old_value}
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-gray-800">
                    {log.new_value}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                      {log.action}
                    </span>
                  </td>
                </tr>
              ))}
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
            onClick={() => setLogsPage(Math.max(1, logsPage - 1))}
            disabled={logsPage <= 1}
            className="px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Previous
          </button>
          <span className="px-3 py-1 text-sm text-gray-600">
            Page {logsPage} of {totalPages || 1}
          </span>
          <button
            onClick={() => setLogsPage(Math.min(totalPages, logsPage + 1))}
            disabled={logsPage >= totalPages}
            className="px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}