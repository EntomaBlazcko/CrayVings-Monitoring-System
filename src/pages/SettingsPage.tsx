import { useState, useEffect } from "react";
import axios from "axios";
import { Settings, Server, RefreshCw, AlertTriangle, Save } from "lucide-react";
import { API_BASE, SETTINGS_ENDPOINT, type SensorSettings } from "../types";

const DEFAULT_SETTINGS: SensorSettings = {
  temp_min: 20.0,
  temp_max: 31.0,
  ph_min: 6.5,
  ph_max: 8.5,
  do_min: 5.0,
  do_max: 10.0,
  water_level_min: 10.0,
  water_level_max: 100.0,
  ammonia_min: 0.0,
  ammonia_max: 0.5,
};

export default function SettingsPage() {
  const [apiUrl] = useState(API_BASE);
  const [settings, setSettings] = useState<SensorSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const res = await axios.get<SensorSettings>(SETTINGS_ENDPOINT);
      if (res.data) {
        setSettings(res.data);
      }
      setError("");
    } catch (err) {
      console.error("Fetch settings error:", err);
      setError("Failed to load settings");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const settingsToSave = {
        temp_min: settings.temp_min,
        temp_max: settings.temp_max,
        ph_min: settings.ph_min,
        ph_max: settings.ph_max,
        do_min: settings.do_min,
        do_max: settings.do_max,
        water_level_min: settings.water_level_min,
        water_level_max: settings.water_level_max,
        ammonia_min: settings.ammonia_min,
        ammonia_max: settings.ammonia_max,
      };
      await axios.post(SETTINGS_ENDPOINT, settingsToSave);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Save settings error:", err);
      setError("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: keyof SensorSettings, value: number) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-gray-500">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="text-gray-600" size={20} />
          <h2 className="mt-0 text-gray-800">Settings</h2>
        </div>
        <p className="text-gray-600 mb-0">Configure sensor thresholds. Alerts are logged when values go outside the safe range.</p>
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
                disabled
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500"
              />
            </div>
            <div className="text-xs text-gray-500">
              Connected to backend server.
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
                defaultValue={3}
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
          <AlertTriangle className="text-orange-600" size={18} />
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
            Alert Thresholds
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
            <div className="text-xs font-semibold text-blue-700 uppercase mb-2">Temperature (°C)</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Min</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.temp_min}
                  onChange={(e) => updateSetting("temp_min", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Max</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.temp_max}
                  onChange={(e) => updateSetting("temp_max", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-100">
            <div className="text-xs font-semibold text-emerald-700 uppercase mb-2">pH Level</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Min</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.ph_min}
                  onChange={(e) => updateSetting("ph_min", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Max</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.ph_max}
                  onChange={(e) => updateSetting("ph_max", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          <div className="bg-sky-50 rounded-lg p-3 border border-sky-100">
            <div className="text-xs font-semibold text-sky-700 uppercase mb-2">Dissolved Oxygen (mg/L)</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Min</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.do_min}
                  onChange={(e) => updateSetting("do_min", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Max</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.do_max}
                  onChange={(e) => updateSetting("do_max", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          <div className="bg-indigo-50 rounded-lg p-3 border border-indigo-100">
            <div className="text-xs font-semibold text-indigo-700 uppercase mb-2">Water Level (%)</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Min</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.water_level_min}
                  onChange={(e) => updateSetting("water_level_min", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Max</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.water_level_max}
                  onChange={(e) => updateSetting("water_level_max", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          <div className="bg-orange-50 rounded-lg p-3 border border-orange-100">
            <div className="text-xs font-semibold text-orange-700 uppercase mb-2">Ammonia (ppm)</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Min</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.ammonia_min}
                  onChange={(e) => updateSetting("ammonia_min", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Max</label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.ammonia_max}
                  onChange={(e) => updateSetting("ammonia_max", Number(e.target.value))}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Save size={16} />
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {saved && (
          <span className="text-sm text-green-600 font-medium">Settings saved!</span>
        )}
      </div>
    </div>
  );
}