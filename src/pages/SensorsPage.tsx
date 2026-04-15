import type { SensorEntry } from "../types";

type Props = {
  data: SensorEntry | null;
};

export default function SensorsPage({ data }: Props) {
  if (!data) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <h2 className="mt-0 text-gray-800">Sensors</h2>
        <p className="text-gray-600">No sensor data available yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <h2 className="mt-0 text-gray-800">Sensors</h2>
      <p><strong>Temperature:</strong> {data.temperature}°C</p>
      <p><strong>Water Level:</strong> {data.water_level} cm</p>
      <p><strong>pH Level:</strong> {data.ph}</p>
      <p><strong>Dissolved Oxygen:</strong> {data.dissolved_oxygen}</p>
      <p><strong>Ammonia:</strong> {data.ammonia}</p>
      <p><strong>Device ID:</strong> {data.device_id}</p>
      <p>
        <strong>Last Update:</strong>{" "}
        {data.timestamp ? new Date(data.timestamp).toLocaleString() : "N/A"}
      </p>
    </div>
  );
}
