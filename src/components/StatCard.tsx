// KPI stat card; color-codes its value against the configured safe range and
// states how fresh the reading is, so a stalled value never looks live.
import type { ThresholdStatus } from "../types";
import { useEffect, useState } from "react";

type Props = {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
  loading?: boolean;
  status?: ThresholdStatus;
  rangeLabel?: string;
  /** Timestamp of the reading this card is showing. */
  updatedAt?: Date | string | null;
  /** True when the card's data is older than it should be (stale fetch). */
  stale?: boolean;
};

const STATUS_LABEL: Record<ThresholdStatus, string> = {
  good: "Safe",
  warning: "Warning",
  critical: "Critical",
};

const STATUS_PILL: Record<ThresholdStatus, string> = {
  good: "bg-status-good-soft text-status-good-text",
  warning: "bg-status-warning-soft text-status-warning-text",
  critical: "bg-status-critical-soft text-status-critical-text",
};

const STATUS_ICON_BG: Record<ThresholdStatus, string> = {
  good: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

const STATUS_CARD_BORDER: Record<ThresholdStatus, string> = {
  good: "border-gray-100",
  warning: "border-status-warning-border border-l-4 border-l-status-warning",
  critical: "border-status-critical-border border-l-4 border-l-status-critical",
};

// Beyond this the reading is no longer "live" and must not be read as current.
const STALE_AFTER_MS = 90_000;

/** Compact relative age, re-rendered on a timer so it never goes stale itself. */
function useRelativeAge(updatedAt: Date | string | null | undefined) {
  const [, force] = useState(0);

  useEffect(() => {
    if (!updatedAt) return;
    const id = setInterval(() => force((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [updatedAt]);

  if (!updatedAt) return null;
  const then = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(then.getTime())) return null;

  const secs = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function StatCard({
  title,
  value,
  color,
  icon,
  loading = false,
  status,
  rangeLabel,
  updatedAt,
  stale = false,
}: Props) {
  const iconColor = status ? STATUS_ICON_BG[status] : color;
  const age = useRelativeAge(updatedAt);

  const ageMs = updatedAt
    ? updatedAt instanceof Date
      ? updatedAt.getTime()
      : new Date(updatedAt).getTime()
    : NaN;
  const isOld = !Number.isNaN(ageMs) && Date.now() - ageMs > STALE_AFTER_MS;

  return (
    <div
      className={`bg-white rounded-card border p-3 flex items-center gap-3 min-h-[88px] shadow-card ${
        status ? STATUS_CARD_BORDER[status] : "border-gray-100"
      } ${stale || isOld ? "opacity-70" : ""}`}
    >
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
        style={{
          backgroundColor: `color-mix(in srgb, ${iconColor} 10%, transparent)`,
          color: iconColor,
        }}
      >
        {icon}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <div className="text-xs font-semibold text-gray-500">{title}</div>
          {status && (
            <span className={`text-micro font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_PILL[status]}`}>
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>
        {loading ? (
          <div className="h-6 w-20 rounded bg-gray-200 animate-pulse" />
        ) : (
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold text-gray-800 leading-none">{value}</div>
            {/* Freshness lives on the card so an operator never has to look up to
                the header to know whether the number beside it is still current. */}
            {age && (
              <span
                title={updatedAt instanceof Date ? updatedAt.toLocaleString() : String(updatedAt)}
                className={`text-micro font-medium ${isOld ? "text-amber-600" : "text-gray-400"}`}
              >
                {isOld && <span aria-hidden="true">⚠ </span>}
                {age}
              </span>
            )}
          </div>
        )}
        {rangeLabel && !loading && (
          <div className="text-xs text-gray-400 mt-1 truncate">{rangeLabel}</div>
        )}
        {(stale || isOld) && !loading && (
          <div className="text-micro font-semibold text-amber-600 mt-0.5">
            {stale ? "Refresh failed — may be outdated" : "No recent update"}
          </div>
        )}
      </div>
    </div>
  );
}
