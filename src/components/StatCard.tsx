// =============================================================================
// FILE: src/components/StatCard.tsx
// =============================================================================
// PURPOSE: Reusable statistic display card component.
//
// Displays a labeled value with an icon in a compact card layout.
// Used on the DashboardPage to show current sensor readings.
//
// PROPS:
//   - title: Label text (e.g., "Temperature")
//   - value: Display value (e.g., "28.5°C")
//   - color: Accent color for the icon circle background
//   - icon: Lucide icon component
// =============================================================================

type Props = {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
  loading?: boolean;
};

/**
 * Compact statistic card showing a title, value, and icon.
 * The icon circle background color is derived from the color prop (with 18% opacity).
 * When loading, a pulsing skeleton placeholder is shown instead of the value.
 */
export default function StatCard({ title, value, color, icon, loading = false }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-3 flex items-center gap-3 min-h-[88px] shadow-sm">
      {/* Icon circle with tinted background */}
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18`, color }}
      >
        {icon}
      </div>

      {/* Title and value */}
      <div>
        <div className="text-xs font-semibold text-gray-500 mb-1">{title}</div>
        {loading ? (
          <div className="h-6 w-20 rounded bg-gray-200 animate-pulse" />
        ) : (
          <div className="text-2xl font-bold text-gray-800 leading-none">{value}</div>
        )}
      </div>
    </div>
  );
}
