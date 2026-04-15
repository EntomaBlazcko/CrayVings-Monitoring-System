import type { SensorEntry } from "../types";
import { getAlerts } from "../utils/alerts";

type Props = {
  data: SensorEntry | null;
};

export default function AlertsPage({ data }: Props) {
  const alerts = getAlerts(data);
  const safe = alerts.length === 1 && alerts[0] === "Tank is Safe";

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <h2 className="mt-0 text-gray-800">Alerts</h2>

      <div className="flex flex-col gap-2.5">
        {alerts.map((alert, index) => (
          <div
            key={index}
            className={`rounded-lg p-3 font-bold ${
              safe ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
            }`}
          >
            {alert}
          </div>
        ))}
      </div>
    </div>
  );
}
