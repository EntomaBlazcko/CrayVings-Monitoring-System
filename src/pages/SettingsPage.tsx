import { useState } from "react";
import { Settings, Server, RefreshCw, Bell, Save } from "lucide-react";
import { API_BASE } from "../types";

const DEFAULT_REFRESH_INTERVAL = 5;

const DEFAULT_THRESHOLDS = {
  temperature: { min: 20, max: 30 },
  water_level: { min: 30, max: 80 },
  ph: { min: 6.5, max: 8.5 },
  ammonia: { min: 0, max: 1 },
  dissolved_oxygen: { min: 5, max: 10 },
};

export default function SettingsPage() {
  const [apiUrl, setApiUrl] = useState(API_BASE);
  const [refreshInterval, setRefreshInterval] = useState(DEFAULT_REFRESH_INTERVAL);
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    localStorage.setItem("crayvings_settings", JSON.stringify({
      apiUrl,
      refreshInterval,
      thresholds,
    }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const updateThreshold = (key: keyof typeof DEFAULT_THRESHOLDS, field: "min" | "max", value: number) => {
    setThresholds(prev => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="text-gray-600" size={20} />
          <h2 className="mt-0 text-gray-800">Settings</h2>
        </div>
        <p className="text-gray-600 mb-0">Configure system preferences and alert thresholds.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Server className="text-blue-600" size={18} />
            <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
              API Configuration
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Backend API URL
              </label>
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="http://192.168.1.20:3000"
              />
            </div>
            <div className="text-xs text-gray-500">
              Change the API URL to connect to a different backend server.
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <RefreshCw className="text-green-600" size={18} />
            <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
              Data Refresh
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Refresh Interval (seconds)
              </label>
              <input
                type="number"
                min="1"
                max="60"
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>
            <div className="text-xs text-gray-500">
              How often to fetch new sensor data (1-60 seconds).
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="text-orange-600" size={18} />
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
            Alert Thresholds
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {Object.entries(thresholds).map(([key, { min, max }]) => (
            <div key={key} className="bg-gray-50 rounded-lg p-3 border border-gray-100">
              <div className="text-xs font-semibold text-gray-600 uppercase mb-2">
                {key.replace(/_/g, " ")}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Min</label>
                  <input
                    type="number"
                    step="0.1"
                    value={min}
                    onChange={(e) => updateThreshold(key as keyof typeof DEFAULT_THRESHOLDS, "min", Number(e.target.value))}
                    className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-0.5">Max</label>
                  <input
                    type="number"
                    step="0.1"
                    value={max}
                    onChange={(e) => updateThreshold(key as keyof typeof DEFAULT_THRESHOLDS, "max", Number(e.target.value))}
                    className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Save size={16} />
          Save Settings
        </button>
        {saved && (
          <span className="text-sm text-green-600 font-medium">Settings saved!</span>
        )}
      </div>
    </div>
  );
}
