"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";
import Image from "next/image";
import {
  LayoutDashboard,
  KeyRound,
  Settings,
  ScrollText,
  LogOut,
  Layers,
} from "lucide-react";
import clsx from "clsx";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/categories", label: "AI Categories", icon: Layers },
  { href: "/dashboard/keywords", label: "Keywords", icon: KeyRound },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
  { href: "/dashboard/logs", label: "Moderation Logs", icon: ScrollText },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 bg-brand-500 border-r border-brand-600/20 flex flex-col z-40">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-white/20">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white/20 flex items-center justify-center">
            <img src="/img/Bear_logo.png" alt="Socialbear" width={20} height={20} className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-white font-bold text-sm tracking-tight">
              Socialbear AI
            </h2>
            <p className="text-white/80 text-[11px]">AI Copilot</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
                isActive
                  ? "bg-white/20 text-white"
                  : "text-white/80 hover:text-white hover:bg-white/10"
              )}
            >
              <Icon
                className={clsx(
                  "w-[18px] h-[18px]",
                  isActive ? "text-white" : "text-white/70"
                )}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="px-3 py-4 border-t border-white/20">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/80 hover:text-white hover:bg-white/10 transition-all w-full"
        >
          <LogOut className="w-[18px] h-[18px] text-white/80" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
