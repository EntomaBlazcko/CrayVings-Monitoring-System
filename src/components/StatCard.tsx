type Props = {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
};

export default function StatCard({ title, value, color, icon }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-3 flex items-center gap-3 min-h-[88px] shadow-sm">
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18`, color }}
      >
        {icon}
      </div>

      <div>
        <div className="text-xs font-semibold text-gray-500 mb-1">{title}</div>
        <div className="text-2xl font-bold text-gray-800 leading-none">{value}</div>
      </div>
    </div>
  );
}
