import type { ChartPoint } from "../types";
import TrendCard from "../components/TrendCard";

type Props = {
  history: ChartPoint[];
};

export default function HistoricalDataPage({ history }: Props) {
  if (!history.length) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <h2 className="mt-0 text-gray-800">Historical Data</h2>
        <p className="text-gray-600">No historical data available yet.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <TrendCard
        title="Temperature History"
        data={history}
        dataKey="temperature"
        stroke="#f97316"
      />
      <TrendCard
        title="Water Level History"
        data={history}
        dataKey="water_level"
        stroke="#2563eb"
      />
      <TrendCard
        title="pH History"
        data={history}
        dataKey="ph"
        stroke="#6366f1"
      />
      <TrendCard
        title="Ammonia History"
        data={history}
        dataKey="ammonia"
        stroke="#06b6d4"
      />
    </div>
  );
}
