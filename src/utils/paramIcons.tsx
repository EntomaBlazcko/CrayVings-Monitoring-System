import { Thermometer, Waves, FlaskConical } from "lucide-react";
import type { ReactNode } from "react";

// Per-parameter icons, keyed by both sensor key and display name.
export const PARAM_ICON: Record<string, ReactNode> = {
  Temperature: <Thermometer size={16} className="text-orange-500" />,
  "Water Level": <Waves size={16} className="text-blue-500" />,
  Ammonia: <FlaskConical size={16} className="text-emerald-500" />,
  temperature: <Thermometer size={16} className="text-orange-500" />,
  water_level: <Waves size={16} className="text-blue-500" />,
  ammonia: <FlaskConical size={16} className="text-emerald-500" />,
};
