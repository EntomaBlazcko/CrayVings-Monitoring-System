import { User, Shield } from "lucide-react";
import type { AuthUser } from "../types";
import { tankOptionLabel } from "../types";
import { useSensorData } from "../hooks/useSensors";

interface HeaderProps {
  user: AuthUser;
  onLogout: () => void;
}

// Global tank switcher: visible on every page (including Alerts/Logs/Settings
// where no per-page tank bar exists) so the selected tank is always visible
// and always switchable. Selecting a tank here updates every page at once.
// Options carry the raw device id when the friendly name differs, so two
// tanks sharing a display name stay distinguishable.
function TankDropdown() {
  const { devices, devicesLoading, selectedDeviceId, setSelectedDeviceId } = useSensorData();

  if (devicesLoading && devices.length === 0) {
    return (
      <span className="text-xs bg-white/20 px-3 py-1.5 rounded-md font-semibold animate-pulse">
        Loading tanks...
      </span>
    );
  }

  if (devices.length === 0) {
    return (
      <span className="text-xs bg-white/20 px-3 py-1.5 rounded-md font-semibold">
        No tanks
      </span>
    );
  }

  return (
    <label className="flex items-center gap-2 text-xs font-semibold">
      <span className="hidden md:inline opacity-90">Tank</span>
      <select
        value={selectedDeviceId ?? ""}
        onChange={(e) => setSelectedDeviceId(e.target.value || null)}
        aria-label="Select tank"
        className="max-w-[240px] truncate rounded-md border-none bg-white/95 text-gray-800 px-2.5 py-1.5 text-xs font-bold text-gray-800 shadow-sm outline-none cursor-pointer hover:bg-white"
      >
        {[...devices]
          .sort((a, b) => a.device_id.localeCompare(b.device_id))
          .map((device) => (
            <option key={device.device_id} value={device.device_id}>
              {`${device.online ? "●" : "○"} ${tankOptionLabel(device)}${device.online ? "" : " (offline)"}`}
            </option>
          ))}
      </select>
    </label>
  );
}

export default function Header({ user, onLogout }: HeaderProps) {
  const roleLabel = user.owner ? "owner" : user.role;
  return (
    <div className="h-16 bg-gradient-to-r from-[#d94b1e] to-[#ef6a2e] text-white flex items-center justify-between px-5 shadow-md">
      <div>
        <div className="text-xl font-extrabold">CRAYvings Monitoring System</div>
        <div className="text-[11px] opacity-90">Smart aquaculture monitoring dashboard</div>
      </div>

      <div className="flex items-center gap-3">
        <TankDropdown />
        <div className="flex items-center gap-2 font-bold text-sm">
          {user.role === "admin" ? <Shield size={16} /> : <User size={16} />}
          <span className="hidden sm:inline">{user.name}</span>
          <span className="text-xs opacity-75 capitalize">({roleLabel})</span>
        </div>
        <button
          onClick={onLogout}
          className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-md font-semibold transition-colors"
        >
          Logout
        </button>
      </div>
    </div>
  );
}
