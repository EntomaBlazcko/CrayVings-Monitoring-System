// =============================================================================
// FILE: src/components/TrendCard.tsx
// PURPOSE: Recharts line chart card for visualizing sensor trends over time.
// Optionally overlays the configured safe range as a shaded band so threshold
// breaches are visible at a glance, and an optional moving-average overlay.
//
// NOTE: The safe band + limit lines are drawn with plain Area/Line series
// instead of ReferenceArea/ReferenceLine. Recharts 3.8.1's reference-elements
// slice dispatches on every render (no deps array) and, combined with React 19,
// triggers "Maximum update depth exceeded" white-screen crashes. Plain series
// avoid that entirely.
// =============================================================================

import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { ChartPoint, ThresholdRange } from "../types";

type Props = {
  title: string;
  data: ChartPoint[];
  dataKey: keyof Omit<ChartPoint, "name">;
  stroke: string;
  range?: ThresholdRange;
  unit?: string;
  overlayKey?: string;
  overlayStroke?: string;
  overlayName?: string;
};

const BAND_MIN_KEY = "bandMin";
const BAND_MAX_KEY = "bandMax";

// Custom tooltip showing time label and every non-decorator series value.
function CustomTooltip(props: {
  active?: boolean;
  payload?: Array<{
    value: number | null;
    dataKey?: string | number;
    color?: string;
    name?: string | number;
  }>;
  label?: string;
  unit?: string;
}) {
  const { active, payload, label, unit } = props;
  if (!active || !payload?.length) return null;

  const rows = payload.filter(
    (p) => p.dataKey !== BAND_MIN_KEY && p.dataKey !== BAND_MAX_KEY
  );
  if (rows.length === 0) return null;

  const suffix = typeof unit === "string" ? unit : "";
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm text-xs space-y-1">
      <p className="text-gray-500">{label}</p>
      {rows.map((p, i) => (
        <p key={i} className="flex items-center gap-1.5 font-semibold text-gray-800">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: typeof p.color === "string" ? p.color : "#64748b" }}
          />
          <span className="font-normal text-gray-500">
            {p.name != null ? p.name : "Value"}
          </span>
          {typeof p.value === "number" ? `${p.value.toFixed(2)}${suffix}` : "—"}
        </p>
      ))}
    </div>
  );
}

// Computes a Y-axis domain that always contains both the data and the safe band.
function computeDomain(data: ChartPoint[], key: Props["dataKey"], range?: ThresholdRange): [number, number] {
  const values = data
    .map((d) => d[key])
    .filter((v): v is number => typeof v === "number");

  const dataMin = values.length > 0 ? Math.min(...values) : range?.min ?? 0;
  const dataMax = values.length > 0 ? Math.max(...values) : range?.max ?? 100;

  const lo = range ? Math.min(dataMin, range.min) : dataMin;
  const hi = range ? Math.max(dataMax, range.max) : dataMax;

  const pad = (hi - lo) * 0.08 || 1;
  return [lo - pad, hi + pad];
}

// Line chart card that adapts X-axis label density for large datasets.
export default function TrendCard({
  title,
  data,
  dataKey,
  stroke,
  range,
  unit,
  overlayKey,
  overlayStroke,
  overlayName,
}: Props) {
  const isLargeDataset = data.length > 50;
  const domain = computeDomain(data, dataKey, range);

  const chartData = range
    ? data.map((d) => ({ ...d, [BAND_MIN_KEY]: range.min, [BAND_MAX_KEY]: range.max }))
    : data;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-700">{title}</h3>
        <span className="text-xs text-gray-400">{data.length} points</span>
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            interval={isLargeDataset ? Math.floor(data.length / 6) : 0}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
          />
          <YAxis
            domain={domain}
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            width={40}
          />
          <Tooltip content={<CustomTooltip unit={unit} />} />

          {range && (
            <>
              <Area
                dataKey={BAND_MAX_KEY}
                baseValue={range.min}
                stroke="none"
                fill="#10b981"
                fillOpacity={0.08}
                isAnimationActive={false}
                activeDot={false}
              />
              <Line
                dataKey={BAND_MIN_KEY}
                stroke="#ef4444"
                strokeWidth={1}
                strokeDasharray="3 3"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey={BAND_MAX_KEY}
                stroke="#ef4444"
                strokeWidth={1}
                strokeDasharray="3 3"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            </>
          )}

          <Line
            type="monotone"
            dataKey={dataKey}
            name="Value"
            stroke={stroke}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: stroke }}
            isAnimationActive={false}
          />

          {overlayKey && (
            <Line
              type="monotone"
              dataKey={overlayKey}
              name={overlayName ?? "Moving avg"}
              stroke={overlayStroke ?? "#94a3b8"}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}