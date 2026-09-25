// Persistent fleet-wide critical alarm.
//
// Unlike the 5s floating toasts, this never auto-dismisses: it stays pinned for
// as long as any tank is reading outside its critical range. The operator can
// collapse the detail, but the alarm itself cannot be dismissed — only the
// underlying reading resolving it will clear the banner. That mirrors how a
// physical alarm panel behaves and removes the "I blinked and missed it" failure
// mode that a timed toast has by definition.
import { useState } from "react";
import { AlertOctagon, ChevronDown, ChevronUp, Wrench, Bell } from "lucide-react";
import { useFleetAlarms, type FleetAlarm } from "../hooks/useFleetAlarms";
import { buildScenarioGuidance } from "../utils/alertGuidance";
import type { AlertGuidance } from "../utils/alertGuidance";
import { FixLegendModal } from "./FixLegend";
import { useSensorSettings } from "../hooks/useSensors";
import { formatTimeAgo } from "../utils/time";

const PARAM_TINT: Record<FleetAlarm["parameter"], string> = {
  ammonia: "text-red-100",
  temperature: "text-orange-100",
  water_level: "text-sky-100",
};

export default function CriticalAlarmBanner({ onGoToAlerts }: { onGoToAlerts?: () => void }) {
  const { alarms, criticalCount, latestRecvAt } = useFleetAlarms();
  const { settingsFor } = useSensorSettings();
  const [expanded, setExpanded] = useState(true);
  const [guidance, setGuidance] = useState<AlertGuidance | null>(null);

  // Nothing critical right now: render nothing. Warnings are intentionally NOT
  // promoted here — the header badge and per-card pills already cover them, and
  // mixing the two would dilute the one signal that must not be ignored.
  if (criticalCount === 0) return null;

  const criticalAlarms = alarms.filter((a) => a.severity === "critical");
  const tanks = new Set(criticalAlarms.map((a) => a.deviceId)).size;

  const openFix = (alarm: FleetAlarm) => {
    const g = buildScenarioGuidance(
      `${alarm.parameter}:${alarm.direction}`,
      settingsFor(alarm.deviceId),
      alarm.value
    );
    if (g) setGuidance(g);
  };

  return (
    <>
      <div
        role="alert"
        aria-live="assertive"
        className="sticky top-0 z-40 -mx-3 md:-mx-5 px-3 md:px-5 pt-3 md:pt-4 pb-3 bg-gradient-to-r from-red-600 via-red-600 to-red-700 shadow-lg"
      >
        <div className="max-w-[1600px]">
          {/* Headline row */}
          <div className="flex items-start gap-3">
            <span className="shrink-0 mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25">
              <AlertOctagon size={20} className="text-white animate-pulse" />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm font-extrabold text-white tracking-wide">
                  CRITICAL — {criticalCount} reading{criticalCount === 1 ? "" : "s"} out of range
                </p>
                <span className="rounded-full bg-white/15 px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-white">
                  {tanks} tank{tanks === 1 ? "" : "s"} affected
                </span>
                {latestRecvAt && (
                  <span className="text-micro text-red-100">
                    readings {formatTimeAgo(latestRecvAt)}
                  </span>
                )}
              </div>

              {/* Collapsed one-line summary — the part that must always be visible. */}
              {!expanded && (
                <p className="mt-1 text-xs text-red-50 truncate">
                  {criticalAlarms
                    .map((a) => `${a.tankLabel}: ${a.parameterName} ${a.direction.toLowerCase()} ${a.value}${a.unit}`)
                    .join("  ·  ")}
                </p>
              )}

              {expanded && (
                <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {criticalAlarms.map((alarm, i) => (
                    <li
                      key={`${alarm.deviceId}-${alarm.parameter}-${i}`}
                      className="flex items-center gap-2 rounded-lg bg-white/10 px-2.5 py-2 ring-1 ring-white/15"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-micro font-bold uppercase tracking-wide text-red-100">
                          {alarm.tankLabel}
                        </span>
                        <span className="block text-xs font-semibold text-white leading-snug">
                          {alarm.parameterName} {alarm.direction.toLowerCase()}{" "}
                          <span className={`${PARAM_TINT[alarm.parameter]} font-bold`}>
                            {alarm.value}
                            {alarm.unit}
                          </span>
                          <span className="text-red-100 font-normal">
                            {" "}
                            (safe {alarm.range.min}–{alarm.range.max}
                            {alarm.unit})
                          </span>
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => openFix(alarm)}
                        className="shrink-0 inline-flex items-center gap-1 rounded-md bg-white px-2 py-1.5 text-micro font-bold text-red-700 hover:bg-red-50 active:scale-95 transition"
                      >
                        <Wrench size={12} />
                        Fix
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {onGoToAlerts && (
                <button
                  type="button"
                  onClick={onGoToAlerts}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-2.5 py-2 text-xs font-bold text-white ring-1 ring-white/25 hover:bg-white/25 active:scale-95 transition"
                >
                  <Bell size={13} />
                  <span className="hidden sm:inline">Alerts</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse critical alarm details" : "Expand critical alarm details"}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-white ring-1 ring-white/25 hover:bg-white/25 active:scale-95 transition"
              >
                {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {guidance && <FixLegendModal guidance={guidance} onClose={() => setGuidance(null)} />}
    </>
  );
}
