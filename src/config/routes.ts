// =============================================================================
// FILE: src/config/routes.ts
// PURPOSE: Centralized route definitions for navigation and routing
// =============================================================================

import { lazy } from "react";
import type { UserRole, MenuKey } from "../types";
import { LayoutDashboard, Activity, Bell, History, Settings, ClipboardList, FileText, BarChart3 } from "lucide-react";

export interface RouteConfig {
  path: string;
  label: MenuKey;
  icon: React.ComponentType<{ size?: number }>;
  roles: UserRole[];
  component: React.LazyExoticComponent<React.ComponentType<Record<string, never>>>;
}

const DashboardPage = lazy(() => import("../pages/DashboardPage"));
const SensorsPage = lazy(() => import("../pages/SensorsPage"));
const AlertsPage = lazy(() => import("../pages/AlertsPage"));
const HistoricalDataPage = lazy(() => import("../pages/HistoricalDataPage"));
const AnalyticsPage = lazy(() => import("../pages/AnalyticsPage"));
const ActivityLogsPage = lazy(() => import("../pages/ActivityLogsPage"));
const LogsPage = lazy(() => import("../pages/LogsPage"));
const SettingsPage = lazy(() => import("../pages/SettingsPage"));

export const ROUTE_CONFIG: RouteConfig[] = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "user"], component: DashboardPage },
  { path: "/analytics", label: "Analytics", icon: BarChart3, roles: ["admin", "user"], component: AnalyticsPage },
  { path: "/sensors", label: "Sensors", icon: Activity, roles: ["admin", "user"], component: SensorsPage },
  { path: "/alerts", label: "Alerts", icon: Bell, roles: ["admin", "user"], component: AlertsPage },
  { path: "/historical", label: "Historical Data", icon: History, roles: ["admin", "user"], component: HistoricalDataPage },
  { path: "/activity-logs", label: "Activity Logs", icon: ClipboardList, roles: ["admin"], component: ActivityLogsPage },
  { path: "/sensor-logs", label: "Sensor Logs", icon: FileText, roles: ["admin", "user"], component: LogsPage },
  { path: "/settings", label: "Settings", icon: Settings, roles: ["admin"], component: SettingsPage },
];

export function getRoutesForRole(role: UserRole): RouteConfig[] {
  return ROUTE_CONFIG.filter((route) => route.roles.includes(role));
}

export function getRouteByLabel(label: MenuKey): RouteConfig | undefined {
  return ROUTE_CONFIG.find((r) => r.label === label);
}

export function getRouteByPath(path: string): RouteConfig | undefined {
  return ROUTE_CONFIG.find((r) => r.path === path);
}