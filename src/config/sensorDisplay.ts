// =============================================================================
// FILE: src/config/sensorDisplay.ts
// PURPOSE: Centralized sensor display configuration (presentation logic)
// =============================================================================

import type { ThresholdRange } from "../types";
import { Thermometer, Waves, FlaskConical } from "lucide-react";

export interface SensorDisplayConfig {
  key: string;
  name: string;
  unit: string;
  color: string;
  gradient: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  range: ThresholdRange;
  isMinOnly: boolean;
}

export const SENSOR_DISPLAY_CONFIG: Record<string, SensorDisplayConfig> = {
  temperature: {
    key: "temperature",
    name: "Temperature",
    unit: "°C",
    color: "text-brand-500",
    gradient: "from-brand-500 to-brand-600",
    icon: Thermometer,
    range: { min: 20, max: 31 },
    isMinOnly: false,
  },
  water_level: {
    key: "water_level",
    name: "Water Level",
    unit: "%",
    color: "text-blue-500",
    gradient: "from-blue-500 to-sky-500",
    icon: Waves,
    range: { min: 10, max: 100 },
    isMinOnly: false,
  },
  ammonia: {
    key: "ammonia",
    name: "Ammonia",
    unit: "ppm",
    color: "text-emerald-500",
    gradient: "from-emerald-500 to-teal-500",
    icon: FlaskConical,
    range: { min: 0.25, max: 1.0 },
    isMinOnly: false,
  },
};

export function getSensorDisplayConfig(key: string): SensorDisplayConfig {
  return SENSOR_DISPLAY_CONFIG[key] ?? SENSOR_DISPLAY_CONFIG.temperature;
}

export function getAllSensorConfigs(): SensorDisplayConfig[] {
  return Object.values(SENSOR_DISPLAY_CONFIG);
}

export function getStatusColor(status: "good" | "warning" | "critical"): string {
  switch (status) {
    case "good": return "bg-emerald-100 text-emerald-700";
    case "warning": return "bg-amber-100 text-amber-700";
    case "critical": return "bg-red-100 text-red-700";
  }
}

export function getStatusIconColor(status: "good" | "warning" | "critical"): string {
  switch (status) {
    case "good": return "text-emerald-500";
    case "warning": return "text-amber-500";
    case "critical": return "text-red-500";
  }
}

export function getStatusBorder(status: "good" | "warning" | "critical"): string {
  switch (status) {
    case "good": return "border-gray-100";
    case "warning": return "border-amber-200 border-l-4 border-l-amber-500";
    case "critical": return "border-red-200 border-l-4 border-l-red-500";
  }
}

export function getStatusTextColor(status: "good" | "warning" | "critical"): string {
  switch (status) {
    case "good": return "text-emerald-600";
    case "warning": return "text-amber-600";
    case "critical": return "text-red-600";
  }
}

export function getStatusDotColor(status: "good" | "warning" | "critical"): string {
  switch (status) {
    case "good": return "bg-emerald-500";
    case "warning": return "bg-amber-500";
    case "critical": return "bg-red-500";
  }
}