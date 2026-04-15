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

export default function TrendCard({ title, data, dataKey, stroke }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="text-sm font-bold text-gray-500 mb-2.5 text-center">{title}</div>

      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ececec" />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={stroke}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
