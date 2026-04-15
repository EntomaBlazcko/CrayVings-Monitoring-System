import {
  LayoutDashboard,
  Activity,
  Bell,
  History,
  Settings,
  Home,
} from "lucide-react";
import type { MenuKey } from "../types";

const menuItems: { label: MenuKey; icon: React.ReactNode }[] = [
  { label: "Home", icon: <Home size={15} /> },
  { label: "Dashboard", icon: <LayoutDashboard size={15} /> },
  { label: "Sensors", icon: <Activity size={15} /> },
  { label: "Alerts", icon: <Bell size={15} /> },
  { label: "Historical Data", icon: <History size={15} /> },
  { label: "Settings", icon: <Settings size={15} /> },
];

type Props = {
  activeMenu: MenuKey;
  setActiveMenu: (menu: MenuKey) => void;
};

export default function Sidebar({ activeMenu, setActiveMenu }: Props) {
  return (
    <div className="w-24 bg-[#f5efe9] border-r border-[#eadfd6] min-h-screen flex flex-col items-center pt-4">
      <div className="w-14 h-14 rounded-full bg-white flex items-center justify-center overflow-hidden border-2 border-[#e9d3c6] mb-4 text-[10px] font-bold text-[#c2410c]">
        LOGO
      </div>

      <div className="w-full flex flex-col gap-1 px-2">
        {menuItems.map((item) => {
          const isActive = activeMenu === item.label;

          return (
            <button
              key={item.label}
              onClick={() => setActiveMenu(item.label)}
              className={`flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-lg text-[10px] font-semibold text-center cursor-pointer border-none w-full transition-colors ${
                isActive
                  ? "bg-[#ffe7d6] text-[#c2410c] font-bold"
                  : "text-[#9a6b57] hover:bg-[#f8e7db]"
              }`}
            >
              {item.icon}
              <span className="leading-tight">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
