"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase-browser";
import { ModerationLog } from "@/lib/types";
import {
  Search,
  RefreshCw,
  ScrollText,
  Filter,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { format } from "date-fns";
import clsx from "clsx";

const PLATFORMS = ["all", "facebook", "instagram", "twitter", "youtube", "tiktok", "threads", "unknown"];
const ACTIONS = ["all", "flagged", "hidden", "completed", "none"];
const PAGE_SIZE = 20;

export default function LogsPage() {
  const [logs, setLogs] = useState<ModerationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("all");
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const supabase = createClient();

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    let query = supabase
      .from("moderation_logs")
      .select("*", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (platform !== "all") query = query.eq("platform", platform);
    if (action !== "all") query = query.eq("action_taken", action);
    if (search) query = query.ilike("message_text", `%${search}%`);

    const { data, count } = await query;

    if (data) {
      setLogs(data as ModerationLog[]);
    }
    if (count !== null) setTotal(count);
    setLoading(false);
  }, [supabase, page, platform, action, search]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    setPage(0);
  }, [platform, action, search]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const actionColors: Record<string, string> = {
    hidden: "bg-danger-50 text-danger-600",
    flagged: "bg-warning-50 text-warning-600",
    completed: "bg-brand-50 text-brand-600",
    none: "bg-surface-100 text-surface-500",
  };

  return (
    <div className="max-w-6xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 tracking-tight">
            Moderation Logs
          </h1>
          <p className="text-surface-500 text-sm mt-1">
            {total} total entries
          </p>
        </div>
        <button
          onClick={fetchLogs}
          className="p-2 hover:bg-surface-100 rounded-lg text-surface-400 hover:text-surface-600 transition-colors"
        >
          <RefreshCw className={clsx("w-4 h-4", loading && "animate-spin")} />
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-surface-200/80 p-4 mb-4 flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-surface-400" />

        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 text-sm"
            placeholder="Search message text..."
          />
        </div>

        {/* Platform filter */}
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="px-3 py-2 border border-surface-200 rounded-lg text-sm text-surface-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30 bg-white"
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p === "all" ? "All Platforms" : p.charAt(0).toUpperCase() + p.slice(1)}
            </option>
          ))}
        </select>

        {/* Action filter */}
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="px-3 py-2 border border-surface-200 rounded-lg text-sm text-surface-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30 bg-white"
        >
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a === "all" ? "All Actions" : a.charAt(0).toUpperCase() + a.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      {logs.length === 0 && !loading ? (
        <div className="bg-white rounded-2xl border border-surface-200/80 p-12 text-center">
          <ScrollText className="w-10 h-10 text-surface-300 mx-auto mb-3" />
          <p className="text-surface-500 text-sm">
            No log entries found matching your filters.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-surface-200/80 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm log-table">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">
                    Message
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">
                    Platform
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">
                    Confidence
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">
                    Rule
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className="hover:bg-surface-50/50 transition-colors"
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-surface-500 font-mono text-xs">
                      {format(new Date(log.created_at), "MMM d, HH:mm:ss")}
                    </td>
                    <td className="px-4 py-3 max-w-xs truncate text-surface-700">
                      {log.message_text || "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="px-2 py-0.5 bg-surface-100 rounded text-xs font-medium text-surface-600 capitalize">
                        {log.platform}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">
                      <span
                        className={clsx(
                          "font-semibold",
                          log.confidence >= 0.7
                            ? "text-danger-500"
                            : log.confidence >= 0.4
                            ? "text-warning-500"
                            : "text-surface-500"
                        )}
                      >
                        {(log.confidence * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-surface-500">
                      {log.matched_keyword ? (
                        <span className="px-2 py-0.5 bg-purple-50 text-purple-600 rounded font-mono">
                          {log.matched_keyword}
                        </span>
                      ) : log.rule_triggered ? (
                        log.rule_triggered
                      ) : (
                        "AI"
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={clsx(
                          "px-2 py-0.5 rounded text-xs font-medium capitalize",
                          actionColors[log.action_taken] || actionColors.none
                        )}
                      >
                        {log.action_taken}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-surface-100">
              <p className="text-xs text-surface-400">
                Page {page + 1} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  className="p-1.5 hover:bg-surface-100 rounded disabled:opacity-30 text-surface-500"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-1.5 hover:bg-surface-100 rounded disabled:opacity-30 text-surface-500"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
