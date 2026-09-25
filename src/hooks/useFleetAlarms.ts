// Fleet-wide critical alarm state.
//
// The floating toasts in components/FloatingAlert.tsx are deliberately
// ephemeral (5s auto-dismiss) and only cover the tank that happened to breach
// while the operator was looking. That is fine for a warning, but a critical
// ammonia or temperature excursion can kill crayfish within hours, so it must
// also be surfaced as something that persists on screen until the underlying
// reading recovers.
//
// This hook is the single source of truth for "is any tank critical right now",
// shared by the persistent banner and the sidebar badge so the two can never
// disagree. Server-side SMS escalation already exists (see server.cjs), so this
// covers the in-app visual gap only.
import { useMemo } from "react";
import { useSensorData, useSensorSettings } from "./useSensors";
import { getThresholdStatus } from "../types";
import { formatTimeAgo } from "../utils/time";

export type AlarmSeverity = "critical" | "warning";

export type FleetAlarm = {
  deviceId: string;
  tankLabel: string;
  parameter: "temperature" | "water_level" | "ammonia";
  parameterName: string;
  value: number;
  unit: string;
  direction: "Low" | "High";
  range: { min: number; max: number };
  severity: AlarmSeverity;
  /** Newest reading timestamp for this tank, for the staleness hint. */
  recvAt: string | null;
};

// Ordered by how fast each parameter can hurt the stock. Ammonia is lethal
// first (toxic gill damage in hours), then temperature, then water level.
const SEVERITY_RANK: Record<AlarmSeverity, number> = { critical: 0, warning: 1 };
const PARAM_RANK: Record<FleetAlarm["parameter"], number> = { ammonia: 0, temperature: 1, water_level: 2 };

export function useFleetAlarms(): {
  alarms: FleetAlarm[];
  criticalCount: number;
  warningCount: number;
  worstSeverity: AlarmSeverity | null;
  latestRecvAt: Date | null;
} {
  const { latestByTank, devices } = useSensorData();
  const { thresholdsFor } = useSensorSettings();

  return useMemo(() => {
    const labelFor = (deviceId: string) => {
      const d = devices.find((x) => x.device_id === deviceId);
      return d?.tank_name || d?.name || deviceId;
    };

    const alarms: FleetAlarm[] = [];

    for (const [deviceId, reading] of Object.entries(latestByTank)) {
      if (!reading) continue;
      const thresholds = thresholdsFor(deviceId);

      for (const parameter of ["temperature", "water_level", "ammonia"] as const) {
        const value = reading[parameter];
        // A null reading is a failed sensor, not a breach — getThresholdStatus
        // already returns "good" for null, so this never raises a false alarm.
        if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;

        const t = thresholds[parameter];
        const num = Number(value);
        const status = getThresholdStatus(num, t.range, t.isMinOnly);
        if (status === "good") continue;

        alarms.push({
          deviceId,
          tankLabel: labelFor(deviceId),
          parameter,
          parameterName: t.name,
          value: num,
          unit: t.unit,
          direction: num < t.range.min ? "Low" : "High",
          range: t.range,
          severity: status === "critical" ? "critical" : "warning",
          recvAt: reading.recv_at ?? null,
        });
      }
    }

    // Critical first, then the most lethal parameter, then tank name for stability.
    alarms.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        PARAM_RANK[a.parameter] - PARAM_RANK[b.parameter] ||
        a.tankLabel.localeCompare(b.tankLabel)
    );

    const times = Object.values(latestByTank)
      .map((r) => (r?.recv_at ? new Date(r.recv_at) : null))
      .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
    const latestRecvAt = times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;

    return {
      alarms,
      criticalCount: alarms.filter((a) => a.severity === "critical").length,
      warningCount: alarms.filter((a) => a.severity === "warning").length,
      worstSeverity: alarms.length ? alarms[0].severity : null,
      latestRecvAt,
    };
  }, [latestByTank, devices, thresholdsFor]);
}

export { formatTimeAgo };
