import { User } from "lucide-react";

export default function Header() {
  return (
    <div className="h-16 bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white flex items-center justify-between px-5 shadow-md">
      <div>
        <div className="text-xl font-extrabold">CRAYvings Monitoring System</div>
        <div className="text-[11px] opacity-90">Smart aquaculture monitoring dashboard</div>
      </div>

      <div className="flex items-center gap-2 font-bold text-sm">
        <User size={16} />
        Admin
      </div>
    </div>
  );
}
