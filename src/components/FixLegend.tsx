// =============================================================================
// src/components/FixLegend.tsx
// Shared "Fix Legend" surface: a severity key + scenario guidance panel and a
// single-scenario modal. Used on Dashboard, Sensors, Alerts, and the floating
// alert toasts so fix guidance is consistent throughout the web app.
// =============================================================================

import { useEffect, useState, type ReactNode } from "react";
import {
  X,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  Thermometer,
  Waves,
  FlaskConical,
  AlertTriangle,
  AlertCircle,
  Settings2,
} from "lucide-react";
import {
  ALERT_SCENARIO_KEYS,
  buildScenarioGuidance,
  type AlertGuidance,
} from "../utils/alertGuidance";
import { SENSOR_KEY_TO_DISPLAY } from "../types";

const PARAM_ICON: Record<string, ReactNode> = {
  Temperature: <Thermometer size={16} className="text-orange-500" />,
  "Water Level": <Waves size={16} className="text-blue-500" />,
  Ammonia: <FlaskConical size={16} className="text-emerald-500" />,
  temperature: <Thermometer size={16} className="text-orange-500" />,
  water_level: <Waves size={16} className="text-blue-500" />,
  ammonia: <FlaskConical size={16} className="text-emerald-500" />,
};

// What each status pill means — mirrors the server's 15% deviation margin.
const SEVERITY_KEY = [
  {
    level: "Safe",
    cls: "bg-emerald-100 text-emerald-700 border-emerald-200",
    desc: "Reading is inside the configured safe range.",
  },
  {
    level: "Warning",
    cls: "bg-amber-100 text-amber-700 border-amber-200",
    desc: "Outside the safe range by up to 15% — act soon.",
  },
  {
    level: "Critical",
    cls: "bg-red-100 text-red-700 border-red-200",
    desc: "Outside the safe range by more than 15% — act immediately.",
  },
] as const;

// ========================
// LEGEND PANEL
// ========================
export function FixLegendPanel({
  counts,
  activeKeys,
  onOpenFix,
}: {
  counts?: Record<string, number>;
  activeKeys?: string[];
  onOpenFix?: (scenarioKey: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Lightbulb size={16} className="text-orange-500" />
          Fix Legend
          <span className="text-[10px] font-medium text-gray-400">how to respond to each sensor alert</span>
        </span>
        {open ? (
          <ChevronUp size={16} className="text-gray-400" />
        ) : (
          <ChevronDown size={16} className="text-gray-400" />
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100 p-4">
          {/* Severity key */}
          <div className="mb-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
            {SEVERITY_KEY.map((s) => (
              <div key={s.level} className={`rounded-lg border px-3 py-2 ${s.cls}`}>
                <p className="text-[11px] font-bold uppercase tracking-wide">{s.level}</p>
                <p className="text-[11px] opacity-80 mt-0.5">{s.desc}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {ALERT_SCENARIO_KEYS.map((key) => {
              const parameterKey = key.split(":")[0];
              const direction = key.split(":")[1] as "High" | "Low";
              const displayParam = SENSOR_KEY_TO_DISPLAY[parameterKey] ?? parameterKey;
              const isHigh = direction === "High";
              const sceneKey = `${displayParam}:${direction}`;
              const count = counts?.[sceneKey] ?? 0;
              const active = activeKeys?.includes(key);
              const scenario = buildScenarioGuidance(key);
              if (!scenario) return null;

              return (
                <div key={key} className={`rounded-lg border p-3 ${active ? "border-orange-400 bg-orange-50/70" : "border-gray-200 bg-gray-50/60"}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {PARAM_ICON[parameterKey] ?? PARAM_ICON[displayParam]}
                    <span className="text-sm font-bold text-gray-800">{scenario.name}</span>
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${isHigh ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                      {direction}
                    </span>
                    {active && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-orange-100 text-orange-700">Active now</span>
                    )}
                    {count > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700">
                        {count} in view
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mt-1.5">{scenario.diagnosis}</p>
                  <ol className="mt-1.5 space-y-1 text-xs text-gray-700">
                    {scenario.fixes.map((fix, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="font-bold text-gray-400 shrink-0">{i + 1}.</span>
                        <span>{fix}</span>
                      </li>
                    ))}
                  </ol>
                  {scenario.preventionTip && (
                    <p className="mt-1.5 text-[11px] text-emerald-700">
                      <span className="font-semibold">Tip:</span> {scenario.preventionTip}
                    </p>
                  )}
                  {onOpenFix && (
                    <button
                      onClick={() => onOpenFix(key)}
                      className="mt-2 text-[11px] font-semibold text-orange-600 hover:text-orange-700 transition"
                    >
                      How to fix →
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ========================
// SINGLE-SCENARIO MODAL
// ========================
export function FixLegendModal({
  guidance,
  onClose,
  onAdjustThresholds,
}: {
  guidance: AlertGuidance;
  onClose: () => void;
  onAdjustThresholds?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const displayParam = SENSOR_KEY_TO_DISPLAY[guidance.parameterKey] ?? guidance.parameterKey;
  const isCritical = guidance.severity === "critical";
  const severityPill = isCritical
    ? "bg-red-100 text-red-700"
    : guidance.severity === "warning"
      ? "bg-amber-100 text-amber-700"
      : "bg-orange-100 text-orange-700";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`How to fix ${displayParam} alert`}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-4 bg-gray-50 border-b border-gray-100">
          <div className="flex items-center gap-2">
            {PARAM_ICON[guidance.parameterKey] ?? PARAM_ICON[displayParam]}
            <div>
              <h3 className="font-bold text-gray-800 leading-tight">{guidance.name}</h3>
              <p className="text-[10px] text-gray-400">{guidance.direction} — {guidance.unit}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold ${severityPill}`}>
              {isCritical ? <AlertTriangle size={12} /> : <AlertCircle size={12} />}
              {isCritical ? "Critical" : "Warning"}
            </span>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
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

        {onAdjustThresholds && (
          <div className="p-4 border-t border-gray-100">
            <button
              onClick={onAdjustThresholds}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 transition"
            >
              <Settings2 size={13} />
              Adjust thresholds
            </button>
          </div>
        )}
      </div>
    </div>
  );
}