import clsx from "clsx";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color: "green" | "red" | "orange" | "blue" | "purple";
  subtitle?: string;
}

const colorMap = {
  green: {
    bg: "bg-brand-500/8",
    icon: "bg-brand-500/12 text-brand-500",
    text: "text-brand-600",
  },
  red: {
    bg: "bg-danger-500/8",
    icon: "bg-danger-500/12 text-danger-500",
    text: "text-danger-600",
  },
  orange: {
    bg: "bg-warning-500/8",
    icon: "bg-warning-500/12 text-warning-500",
    text: "text-warning-600",
  },
  blue: {
    bg: "bg-blue-500/8",
    icon: "bg-blue-500/12 text-blue-500",
    text: "text-blue-600",
  },
  purple: {
    bg: "bg-purple-500/8",
    icon: "bg-purple-500/12 text-purple-500",
    text: "text-purple-600",
  },
};

export default function StatCard({
  label,
  value,
  icon: Icon,
  color,
  subtitle,
}: StatCardProps) {
  const colors = colorMap[color];

  return (
    <div className="bg-white rounded-2xl border border-surface-200/80 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-surface-500 font-medium">{label}</p>
          <p
            className={clsx(
              "text-3xl font-bold mt-1.5 tracking-tight",
              colors.text
            )}
          >
            {value}
          </p>
          {subtitle && (
            <p className="text-xs text-surface-400 mt-1">{subtitle}</p>
          )}
        </div>
        <div
          className={clsx(
            "w-10 h-10 rounded-xl flex items-center justify-center",
            colors.icon
          )}
        >
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}
