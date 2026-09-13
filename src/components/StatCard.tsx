// =============================================================================
// FILE: src/components/StatCard.tsx
// =============================================================================
// PURPOSE: Reusable statistic card. Optionally color-codes each value against
// its configured safe range (good/warning/critical) like a monitoring tile.
// =============================================================================

import type { ThresholdStatus } from "../types";

type Props = {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
  loading?: boolean;
  status?: ThresholdStatus;
  rangeLabel?: string;
};

const STATUS_LABEL: Record<ThresholdStatus, string> = {
  good: "Safe",
  warning: "Warning",
  critical: "Critical",
};

const STATUS_PILL: Record<ThresholdStatus, string> = {
  good: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  critical: "bg-red-100 text-red-700",
};

const STATUS_ICON_BG: Record<ThresholdStatus, string> = {
  good: "#10b981",
  warning: "#f59e0b",
  critical: "#ef4444",
};

const STATUS_CARD_BORDER: Record<ThresholdStatus, string> = {
  good: "border-gray-100",
  warning: "border-amber-200 border-l-4 border-l-amber-500",
  critical: "border-red-200 border-l-4 border-l-red-500",
};

export default function StatCard({ title, value, color, icon, loading = false, status, rangeLabel }: Props) {
  const iconColor = status ? STATUS_ICON_BG[status] : color;

  return (
    <div
      className={`bg-white rounded-xl border p-3 flex items-center gap-3 min-h-[88px] shadow-sm ${
        status ? STATUS_CARD_BORDER[status] : "border-gray-100"
      }`}
    >
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${iconColor}18`, color: iconColor }}
      >
        {icon}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <div className="text-xs font-semibold text-gray-500">{title}</div>
          {status && (
            <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[status]}`}>
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>
        {loading ? (
          <div className="h-6 w-20 rounded bg-gray-200 animate-pulse" />
        ) : (
          <div className="text-2xl font-bold text-gray-800 leading-none">{value}</div>
        )}
        {rangeLabel && !loading && (
          <div className="text-[10px] text-gray-400 mt-1 truncate">{rangeLabel}</div>
        )}
      </div>
    </div>
  );
}