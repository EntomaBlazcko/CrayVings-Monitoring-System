// =============================================================================
// FILE: src/components/TrendCard.tsx
// PURPOSE: Recharts line chart card for visualizing sensor trends over time.
// =============================================================================

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { ChartPoint } from "../types";

type Props = {
  title: string;
  data: ChartPoint[];
  dataKey: keyof Omit<ChartPoint, "name">;
  stroke: string;
};

// Custom tooltip showing time label and formatted value on hover.
function CustomTooltip(props: {
  active?: boolean;
  payload?: Array<{ value: number | null }>;
  label?: string;
}) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm text-xs">
      <p className="text-gray-500">{label}</p>
      <p className="font-semibold text-gray-800">{typeof value === "number" ? value.toFixed(1) : "—"}</p>
    </div>
  );
}

// Line chart card that adapts X-axis label density for large datasets.
export default function TrendCard({ title, data, dataKey, stroke }: Props) {
  const isLargeDataset = data.length > 50;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-700">{title}</h3>
        <span className="text-xs text-gray-400">{data.length} points</span>
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            interval={isLargeDataset ? Math.floor(data.length / 6) : 0}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            width={40}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={stroke}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: stroke }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
