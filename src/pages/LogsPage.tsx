// =============================================================================
// FILE: src/pages/LogsPage.tsx
// =============================================================================
// PURPOSE: System logs page with parameter filtering and PDF export.
//
// This page displays system log entries in a table format with:
//   1. Parameter filter buttons: All / Temperature / Water Level / Ammonia
//   2. Paginated table showing timestamp, parameter, old value, new value, action
//   3. PDF export functionality (via jsPDF + autoTable)
//
// PDF EXPORT FEATURES:
//   - Title header with generation timestamp
//   - Summary section with total entries and per-parameter counts
//   - Formatted table with alternating row colors
//   - Page numbers and footer on each page
//   - Filename includes date (e.g., CRAYvings_System_Logs_2025-01-15.pdf)
//
// DATA: System logs from SensorProvider (auto-polled every 5 seconds)
// =============================================================================

import { useState, useMemo, useCallback } from "react";
import { FileText, Download, Clock, Thermometer, Waves, FlaskConical } from "lucide-react";
import { useSensors } from "../hooks/useSensors";
import { Spinner, LoadingCard, ErrorCard } from "../components/Loading";
import { SENSOR_KEY_TO_DISPLAY } from "../types";

const PARAMETER_ICONS: Record<string, React.ReactNode> = {
  Temperature: <Thermometer size={14} className="text-blue-500" />,
  "Water Level": <Waves size={14} className="text-indigo-500" />,
  Ammonia: <FlaskConical size={14} className="text-emerald-500" />,
  temperature: <Thermometer size={14} className="text-blue-500" />,
  water_level: <Waves size={14} className="text-indigo-500" />,
  ammonia: <FlaskConical size={14} className="text-emerald-500" />,
};

const PARAMETERS = ["all", "Temperature", "Water Level", "Ammonia"] as const;

export default function LogsPage() {
  const { logs, logsLoading, logsError, refetchLogs, logsPage, logsTotal, setLogsPage, logsParameterFilter, setLogsParameterFilter } = useSensors();
  const [isChangingPage, setIsChangingPage] = useState(false);

  const getDisplayParameter = (param: string): string => {
    return SENSOR_KEY_TO_DISPLAY[param] ?? param;
  };

  // Logs are already filtered server-side by the active parameter filter.
  const filteredLogs = logs;

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
    if (filteredLogs.length === 0) {
      alert("No logs to export.");
      return;
    }

    // jspdf is heavy (~150kB+), so it's only loaded when the user actually
    // exports a PDF rather than when the Logs page opens.
    let jsPDFModule: typeof import("jspdf");
    let autoTableModule: typeof import("jspdf-autotable");
    try {
      [jsPDFModule, autoTableModule] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
    } catch {
      alert("Failed to load the PDF library. Please try again.");
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
    doc.text(`Generated on ${new Date().toLocaleString()}`, pageWidth / 2, 28, { align: "center" });

  const parameterCounts = filteredLogs.reduce<Record<string, number>>((acc, log) => {
    const displayParam = getDisplayParameter(log.parameter);
    if (["Temperature", "Water Level", "Ammonia"].includes(displayParam)) {
      acc[displayParam] = (acc[displayParam] || 0) + 1;
    }
    return acc;
  }, { Temperature: 0, "Water Level":0, Ammonia: 0 });

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
      log.timestamp ? new Date(log.timestamp).toLocaleString() : "-",
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
        fillColor: [248, 250, 252] 
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

    // Stamp footers after the table is drawn so the page total is accurate.
    // (didDrawPage can't know the final count while earlier pages are rendered.)
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
        `Exported: ${new Date().toLocaleDateString()}`,
        pageWidth - 14,
        pageHeight - 10,
        { align: "right" }
      );
    }

    doc.save(`CRAYvings_System_Logs_${new Date().toISOString().split("T")[0]}.pdf`);
  }, [filteredLogs]);

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

  if (filteredLogs.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2 flex-wrap">
            {PARAMETERS.map((param) => (
              <button
                key={param}
                onClick={() => setLogsParameterFilter(param === "all" ? "" : param)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  (param === "all" && logsParameterFilter === "") || logsParameterFilter === param
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
              onClick={() => setLogsParameterFilter(param === "all" ? "" : param)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                (param === "all" && logsParameterFilter === "") || logsParameterFilter === param
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
    </div>
  );
}
