"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase-browser";
import { DashboardStats } from "@/lib/types";
import StatCard from "@/components/StatCard";
import {
  Activity,
  EyeOff,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Clock,
  RefreshCw,
  Zap,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchStats = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: counters, error: countersErr } = await supabase
      .from("moderation_counters")
      .select("total_processed, flagged, auto_hidden, completed, updated_at")
      .eq("user_id", user.id)
      .single();

    let activeKeywords = 0;
    try {
      const { count } = await supabase
        .from("keyword_rules")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("is_active", true);
      activeKeywords = count || 0;
    } catch {}

    if (!countersErr && counters) {
      setStats({
        total_processed: counters.total_processed ?? 0,
        total_hidden: counters.auto_hidden ?? 0,
        total_flagged: counters.flagged ?? 0,
        total_completed: counters.completed ?? 0,
        today_processed: 0,
        today_hidden: 0,
        last_processed: counters.updated_at ?? null,
        active_keywords: activeKeywords,
      } as DashboardStats);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-surface-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 tracking-tight">
            Dashboard
          </h1>
          <p className="text-surface-500 text-sm mt-1">
            Real-time moderation system overview
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-500/8 rounded-full">
            <div className="w-2 h-2 rounded-full bg-brand-500 live-pulse" />
            <span className="text-xs font-medium text-brand-600">
              System Active
            </span>
          </div>
          <button
            onClick={fetchStats}
            className="p-2 hover:bg-surface-100 rounded-lg text-surface-400 hover:text-surface-600 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total Processed"
          value={stats?.total_processed ?? 0}
          icon={Activity}
          color="blue"
          subtitle={`${stats?.today_processed ?? 0} today`}
        />
        <StatCard
          label="Auto-Hidden"
          value={stats?.total_hidden ?? 0}
          icon={EyeOff}
          color="red"
          subtitle={`${stats?.today_hidden ?? 0} today`}
        />
        <StatCard
          label="Flagged"
          value={stats?.total_flagged ?? 0}
          icon={AlertTriangle}
          color="orange"
        />
        <StatCard
          label="Completed"
          value={stats?.total_completed ?? 0}
          icon={CheckCircle2}
          color="green"
        />
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-2xl border border-surface-200/80 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <KeyRound className="w-4 h-4 text-purple-500" />
            </div>
            <span className="text-sm font-medium text-surface-600">
              Active Keywords
            </span>
          </div>
          <p className="text-2xl font-bold text-surface-900">
            {stats?.active_keywords ?? 0}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-surface-200/80 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Clock className="w-4 h-4 text-blue-500" />
            </div>
            <span className="text-sm font-medium text-surface-600">
              Last Processed
            </span>
          </div>
          <p className="text-lg font-semibold text-surface-900">
            {stats?.last_processed
              ? formatDistanceToNow(new Date(stats.last_processed), {
                  addSuffix: true,
                })
              : "No activity yet"}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-surface-200/80 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center">
              <Zap className="w-4 h-4 text-brand-500" />
            </div>
            <span className="text-sm font-medium text-surface-600">
              API Status
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-brand-500" />
            <p className="text-lg font-semibold text-brand-600">Operational</p>
          </div>
        </div>
      </div>

      {/* Quick Info */}
      <div className="bg-white rounded-2xl border border-surface-200/80 p-6">
        <h3 className="text-sm font-semibold text-surface-900 mb-4">
          System Info
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
          <div>
            <p className="text-surface-400 mb-1">Detection</p>
            <p className="font-medium text-surface-700">
              MutationObserver + Poll
            </p>
          </div>
          <div>
            <p className="text-surface-400 mb-1">AI Engine</p>
            <p className="font-medium text-surface-700">
              OpenAI Moderation API
            </p>
          </div>
          <div>
            <p className="text-surface-400 mb-1">Auto-Refresh</p>
            <p className="font-medium text-surface-700">Every 15s</p>
          </div>
          <div>
            <p className="text-surface-400 mb-1">Extension</p>
            <p className="font-medium text-surface-700">Chrome MV3</p>
          </div>
        </div>
      </div>
    </div>
  );
}
