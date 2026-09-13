// =============================================================================
// src/pages/AnalyticsPage.tsx
// Standalone analytics page: period summary, trends, alerts, device uptime,
// rule-engine suggestions, and daily averages.
// =============================================================================

import AnalyticsSection from "../components/AnalyticsSection";

export default function AnalyticsPage() {
  return (
    <div className="space-y-4">
      <AnalyticsSection />
    </div>
  );
}