import "./App.css";
import { useEffect, useState } from "react";
import axios from "axios";

type SensorEntry = {
  _id?: string;
  device_id: string;
  temperature: number;
  water_level: number;
  timestamp?: string;
};

function App() {
  const [data, setData] = useState<SensorEntry | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const fetchLatestData = async () => {
      try {
        const res = await axios.get<SensorEntry | null>(
          "http://192.168.1.20:3000/sensor/latest"
        );

        console.log("Fetched latest sensor data:", res.data);

        setData(res.data);
        setError("");
      } catch (err) {
        console.error("Error fetching latest sensor data:", err);
        setError("Failed to fetch sensor data.");
      } finally {
        setLoading(false);
      }
    };

    fetchLatestData();

    const interval = setInterval(() => {
      fetchLatestData();
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-10 min-h-screen bg-gray-100">
      <h1 className="text-3xl font-bold mb-6 text-center">
        Aquaculture Monitoring Dashboard
      </h1>

      {loading ? (
        <p className="text-center text-lg">Loading latest sensor data...</p>
      ) : error ? (
        <p className="text-center text-red-500">{error}</p>
      ) : data ? (
        <div className="max-w-xl mx-auto bg-white p-8 rounded-xl shadow-md">
          <h2 className="text-2xl font-semibold mb-4 text-center">
            Device: {data.device_id}
          </h2>

          <p className="text-2xl mb-3">
            Temperature: {data.temperature} °C
          </p>

          <p className="text-2xl mb-3">
            Water Level: {data.water_level} %
          </p>

          <p className="text-sm text-gray-500 mt-6 text-center">
            Last Updated:{" "}
            {data.timestamp
              ? new Date(data.timestamp).toLocaleString()
              : "No timestamp"}
          </p>
        </div>
      ) : (
        <p className="text-center text-red-500">No sensor data found.</p>
      )}
    </div>
  );
}

export default App;