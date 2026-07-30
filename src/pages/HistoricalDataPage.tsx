// =============================================================================
// FILE: src/pages/HistoricalDataPage.tsx
// =============================================================================
// PURPOSE: Historical data analysis page with time-range filtering.
//
// This page allows users to view sensor trends over different time periods:
//   1. Time range selector: 1 Hour / 6 Hours / 24 Hours / All Time
//   2. Two summary cards showing Min/Average/Max for each sensor
//   3. Two full-width line charts (vertical layout for readability)
//
// FEATURES:
//   - Dynamically fetches more data from the backend for longer time ranges
//   - Uses AbortController to cancel stale requests when switching ranges
//   - Filters and sorts data client-side for the selected time window
//   - Shows loading skeletons during data fetch
//
// DATA FLOW:
//   - Short ranges (1h, 6h): Uses locally cached history from SensorProvider
//   - Long ranges (24h, all): Fetches additional data directly from API
//   - Data is filtered by timestamp cutoff based on selected range
// =============================================================================

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  History,
  Thermometer,
  Waves,
  Filter,
  TrendingUp,
  TrendingDown,
  Activity,
} from "lucide-react";
import TrendCard from "../components/TrendCard";
import { useSensors } from "../hooks/useSensors";
import { fetchSensorHistory } from "../api/client";
import type { ChartPoint } from "../types";

type TimeRange = "1h" | "6h" | "24h" | "all";

/**
 * Calculates min, max, and average statistics for each sensor parameter.
 * Returns null if no data is available.
 */
function getStats(data: { temperature?: number | string; water_level?: number | string }[]) {
  if (!data || data.length === 0) return null;

  const calc = (key: "temperature" | "water_level") => {
    const values = data
      .map(d => Number(d[key]))
      .filter(v => !isNaN(v));
    if (values.length === 0) return null;
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    };
  };

  return {
    temperature: calc("temperature"),
    water_level: calc("water_level"),
  };
}

export default function HistoricalDataPage() {
  const { history, loading, error } = useSensors();
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [dynamicHistory, setDynamicHistory] = useState<ChartPoint[]>([]);
  const [dynamicLoading, setDynamicLoading] = useState(false);

  const timeRanges: { value: TimeRange; label: string }[] = [
    { value: "1h", label: "1 Hour" },
    { value: "6h", label: "6 Hours" },
    { value: "24h", label: "24 Hours" },
    { value: "all", label: "All Time" },
  ];

  const getLimitForRange = (range: TimeRange): number => {
    switch (range) {
      case "1h": return 60;
      case "6h": return 360;
      case "24h": return 1440;
      case "all": return 1000;
    }
  };

  const shouldFetchDynamic = (range: TimeRange): boolean => {
    const limit = getLimitForRange(range);
    return limit > 300 || history.length === 0;
  };

  const prevTimeRangeRef = useRef<TimeRange>(timeRange);

  useEffect(() => {
    if (prevTimeRangeRef.current !== timeRange && !shouldFetchDynamic(timeRange)) {
      setDynamicHistory([]);
      setDynamicLoading(false);
    }
    prevTimeRangeRef.current = timeRange;
  }, [timeRange, history.length]);

  const fetchDynamicData = useCallback(async (range: TimeRange, signal: AbortSignal) => {
    const limit = getLimitForRange(range);
    const data = await fetchSensorHistory(limit, signal);
    return data;
  }, []);

  useEffect(() => {
    if (!shouldFetchDynamic(timeRange)) return;

    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDynamicLoading(true);

    fetchDynamicData(timeRange, controller.signal)
      .then(data => {
        setDynamicHistory(data);
        setDynamicLoading(false);
      })
      .catch(() => {
        setDynamicLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [timeRange, history.length, fetchDynamicData]);

  const activeHistory = dynamicHistory.length > 0 ? dynamicHistory : history;
  const activeLoading = dynamicLoading || loading;

  const filteredHistory = useMemo(() => {
    if (!activeHistory || activeHistory.length === 0) return [];

    const sorted = [...activeHistory].sort((a, b) => {
      const ta = new Date(a.timestamp || 0).getTime();
      const tb = new Date(b.timestamp || 0).getTime();
      return ta - tb;
    });

    if (timeRange === "all") return sorted;

    const hours = timeRange === "1h" ? 1 : timeRange === "6h" ? 6 : 24;
    const cutoff = Date.now() - hours * 60 * 60 * 1000;

    return sorted.filter((item) => {
      if (!item.timestamp) return false;
      return new Date(item.timestamp).getTime() >= cutoff;
    });
  }, [activeHistory, timeRange]);

  const stats = useMemo(() => getStats(filteredHistory), [filteredHistory]);

  const latestReading = useMemo(() => {
    if (filteredHistory.length > 0) return filteredHistory[filteredHistory.length - 1];
    if (activeHistory && activeHistory.length > 0) {
      const sorted = [...activeHistory].sort((a, b) => {
        const ta = new Date(a.timestamp || 0).getTime();
        const tb = new Date(b.timestamp || 0).getTime();
        return ta - tb;
      });
      return sorted[sorted.length - 1];
    }
    return null;
  }, [filteredHistory, activeHistory]);

  if (activeLoading) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-48 mb-2"></div>
          <div className="h-4 bg-gray-100 rounded w-64"></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[1, 2].map(i => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-20 mb-2"></div>
              <div className="h-8 bg-gray-100 rounded w-16"></div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3">
          {[1, 2].map(i => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse h-48"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
        <History size={40} className="mx-auto mb-3 text-red-400" />
        <p className="font-semibold">Failed to load historical data</p>
        <p className="text-sm mt-1">{error}</p>
      </div>
    );
  }

  if (!history || history.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <History size={40} className="mx-auto mb-3 text-gray-300" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Historical Data</h2>
        <p className="text-gray-500">No historical data available yet.</p>
        <p className="text-sm text-gray-400 mt-2">Data will appear here once sensors start reporting.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <History size={22} className="text-blue-500" />
              Historical Data
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              View sensor trends over time
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Filter size={16} className="text-gray-400" />
            {timeRanges.map((range) => (
              <button
                key={range.value}
                onClick={() => setTimeRange(range.value)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  timeRange === range.value
                    ? "bg-blue-500 text-white shadow-sm"
                    : "bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 text-sm text-gray-400">
          Showing {filteredHistory.length} of {history.length} readings
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-gray-500">
              <Thermometer size={16} className="text-orange-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Temperature</span>
            </div>
            {stats?.temperature && (
              <div className="flex gap-3 text-xs">
                <span className="text-blue-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {stats.temperature.min.toFixed(1)}°
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {stats.temperature.avg.toFixed(1)}°
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {stats.temperature.max.toFixed(1)}°
                </span>
              </div>
            )}
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {latestReading?.temperature != null ? Number(latestReading.temperature).toFixed(1) : "--"}<span className="text-base font-normal text-gray-500">°C</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-gray-500">
              <Waves size={16} className="text-blue-500" />
              <span className="text-xs font-semibold uppercase tracking-wide">Water Level</span>
            </div>
            {stats?.water_level && (
              <div className="flex gap-3 text-xs">
                <span className="text-blue-600" title="Min">
                  <TrendingDown size={12} className="inline" /> {stats.water_level.min.toFixed(0)}%
                </span>
                <span className="text-green-600" title="Average">
                  <Activity size={12} className="inline" /> {stats.water_level.avg.toFixed(0)}%
                </span>
                <span className="text-red-600" title="Max">
                  <TrendingUp size={12} className="inline" /> {stats.water_level.max.toFixed(0)}%
                </span>
              </div>
            )}
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {latestReading?.water_level != null ? Number(latestReading.water_level).toFixed(0) : "--"}<span className="text-base font-normal text-gray-500">%</span>
          </div>
        </div>
      </div>

      {/* Charts - Vertical layout for better readability */}
      {filteredHistory.length > 0 ? (
        <div className="space-y-3">
          <TrendCard
            title="Temperature (°C)"
            data={filteredHistory}
            dataKey="temperature"
            stroke="#f97316"
          />
          <TrendCard
            title="Water Level (%)"
            data={filteredHistory}
            dataKey="water_level"
            stroke="#2563eb"
          />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <History size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-600 font-medium">No data for selected time range</p>
          <p className="text-sm text-gray-400 mt-1">Try selecting a different time range.</p>
        </div>
      )}
    </div>
  );
}
