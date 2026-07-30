// =============================================================================
// FILE: src/components/TrendCard.tsx
// =============================================================================
// PURPOSE: Line chart card component for displaying sensor trends over time.
//
// Uses Recharts library to render a responsive line chart inside a styled card.
// Used on DashboardPage and HistoricalDataPage for visualizing sensor data.
//
// FEATURES:
//   - Responsive width (fills parent container)
//   - Fixed height (180px) for consistent layout
//   - Custom tooltip showing time and value on hover
//   - Adaptive X-axis label interval for large datasets
//   - Smooth monotone line interpolation
//
// PROPS:
//   - title: Chart title (e.g., "Temperature")
//   - data: Array of ChartPoint objects from the API
//   - dataKey: Which sensor value to plot ("temperature", "water_level")
//   - stroke: Line color (hex string)
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

/**
 * Custom tooltip component for the line chart.
 * Shows the time label and formatted value when hovering over a data point.
 */
function CustomTooltip(props: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm text-xs">
      <p className="text-gray-500">{label}</p>
      <p className="font-semibold text-gray-800">{typeof value === "number" ? value.toFixed(1) : value}</p>
    </div>
  );
}

/**
 * Card component containing a Recharts line chart for sensor trend visualization.
 * Adapts X-axis label density based on dataset size to prevent overcrowding.
 */
export default function TrendCard({ title, data, dataKey, stroke }: Props) {
  // For large datasets, show fewer X-axis labels to prevent overlap
  const isLargeDataset = data.length > 50;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition">
      {/* Chart title and data point count */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-700">{title}</h3>
        <span className="text-xs text-gray-400">{data.length} points</span>
      </div>

      {/* Responsive line chart */}
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            // Skip labels for large datasets to prevent overlap
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
