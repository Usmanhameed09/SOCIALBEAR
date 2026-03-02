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
  Download,
} from "lucide-react";
import { format } from "date-fns";
import clsx from "clsx";

const PLATFORMS = ["all", "facebook", "instagram", "twitter", "youtube", "tiktok", "threads", "unknown"];
const ACTIONS = ["all", "flagged", "hidden", "completed", "none"];
const PAGE_SIZE = 20;

type DisplayLog = ModerationLog & { actions: ModerationLog["action_taken"][] };

const actionPriority: Record<ModerationLog["action_taken"], number> = {
  none: 0,
  flagged: 1,
  hidden: 2,
  completed: 3,
};

const ACTION_ORDER: ModerationLog["action_taken"][] = ["flagged", "hidden", "completed", "none"];

function mergeLogs(rows: ModerationLog[]): DisplayLog[] {
  const groups = new Map<string, ModerationLog[]>();

  for (const row of rows) {
    const key = row.message_id ? row.message_id : row.id;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const merged: DisplayLog[] = [];

  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const latest = sorted[0];

    let bestAction = latest.action_taken;
    for (const row of sorted) {
      if (actionPriority[row.action_taken] > actionPriority[bestAction]) {
        bestAction = row.action_taken;
      }
    }

    const actionSet = new Set<ModerationLog["action_taken"]>(sorted.map((r) => r.action_taken));
    if (actionSet.size > 1) actionSet.delete("none");
    const actions = ACTION_ORDER.filter((a) => actionSet.has(a));

    const ruleSource =
      sorted.find((row) => !!row.matched_keyword) ??
      sorted.find((row) => !!row.rule_triggered && !row.rule_triggered.startsWith("ui:")) ??
      latest;

    merged.push({
      ...ruleSource,
      id: latest.id,
      created_at: latest.created_at,
      platform: latest.platform,
      message_id: latest.message_id,
      message_text: latest.message_text,
      action_taken: bestAction,
      actions: actions.length > 0 ? actions : ["none"],
    });
  }

  return merged.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

function getRuleLabel(log: ModerationLog): string {
  if (log.matched_keyword) return log.matched_keyword;

  const rule = log.rule_triggered || "";
  if (!rule) return "AI";

  if (rule.startsWith("keyword:")) return rule.slice("keyword:".length);
  if (rule.startsWith("ai:")) return rule.slice("ai:".length);
  if (rule.startsWith("ui:")) return "—";

  return rule;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<DisplayLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("all");
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [aiMessageModal, setAiMessageModal] = useState<{
    ai_message: string;
    message_text: string;
    created_at: string;
    platform: string;
  } | null>(null);
  const supabase = createClient();

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }

    let query = supabase
      .from("moderation_logs")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (platform !== "all") query = query.eq("platform", platform);
    if (search) query = query.ilike("message_text", `%${search}%`);

    const { data } = await query;

    const merged = mergeLogs((data || []) as ModerationLog[]);
    const filtered =
      action === "all"
        ? merged
        : merged.filter((row) => row.actions.includes(action as ModerationLog["action_taken"]));

    setLogs(filtered);
    setTotal(filtered.length);
    setLoading(false);
  }, [supabase, platform, action, search]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    setPage(0);
  }, [platform, action, search]);

  const exportToCSV = useCallback(async () => {
    setExporting(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Fetch ALL matching logs (no pagination)
      let query = supabase
        .from("moderation_logs")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (platform !== "all") query = query.eq("platform", platform);
      if (search) query = query.ilike("message_text", `%${search}%`);

      const { data } = await query;
      const merged = mergeLogs((data || []) as ModerationLog[]);
      const filtered =
        action === "all"
          ? merged
          : merged.filter((row) => row.actions.includes(action as ModerationLog["action_taken"]));
      if (filtered.length === 0) return;

      const columns: (keyof ModerationLog)[] = [
        "id",
        "created_at",
        "message_text",
        "platform",
        "confidence",
        "matched_keyword",
        "rule_triggered",
        "ai_message",
        "action_taken",
      ];

      const escapeCell = (val: unknown): string => {
        if (val === null || val === undefined) return "";
        const str = String(val);
        // Wrap in quotes if contains comma, quote, or newline
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const header = columns.join(",");
      const rows = filtered.map((row) =>
        columns.map((col) => escapeCell(row[col])).join(",")
      );
      const csv = [header, ...rows].join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `moderation_logs_${format(new Date(), "yyyy-MM-dd_HH-mm")}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [supabase, platform, action, search]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const pageLogs = logs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
        <div className="flex items-center gap-2">
          <button
            onClick={exportToCSV}
            disabled={exporting || total === 0}
            className="flex items-center gap-1.5 px-3 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Download className={clsx("w-4 h-4", exporting && "animate-bounce")} />
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <button
            onClick={fetchLogs}
            className="p-2 hover:bg-surface-100 rounded-lg text-surface-400 hover:text-surface-600 transition-colors"
          >
            <RefreshCw className={clsx("w-4 h-4", loading && "animate-spin")} />
          </button>
        </div>
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
      {pageLogs.length === 0 && !loading ? (
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
                    AI Message
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {pageLogs.map((log) => (
                  <tr
                    key={log.id}
                    className="hover:bg-surface-50/50 transition-colors"
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-surface-500 font-mono text-xs">
                      {format(new Date(log.created_at), "MMM d, HH:mm:ss")}
                    </td>
                    <td className="px-4 py-3 max-w-xs truncate text-surface-700">
                      {log.message_text ? (
                        <button
                          type="button"
                          onClick={() =>
                            setAiMessageModal({
                              ai_message: log.ai_message || "",
                              message_text: log.message_text || "",
                              created_at: log.created_at,
                              platform: log.platform,
                            })
                          }
                          className="text-left w-full truncate hover:underline text-surface-700"
                          title="Click to view full message"
                        >
                          {log.message_text}
                        </button>
                      ) : (
                        "—"
                      )}
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
                      ) : (
                        getRuleLabel(log)
                      )}
                    </td>
                    <td
                      className="px-4 py-3 max-w-sm truncate text-surface-500"
                    >
                      {log.ai_message ? (
                        <button
                          type="button"
                          onClick={() =>
                            setAiMessageModal({
                              ai_message: log.ai_message || "",
                              message_text: log.message_text || "",
                              created_at: log.created_at,
                              platform: log.platform,
                            })
                          }
                          className="text-left w-full truncate hover:underline"
                          title="Click to view full message"
                        >
                          {log.ai_message}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex flex-wrap gap-1">
                      {log.actions.map((a) => (
                        <span
                          key={a}
                          className={clsx(
                            "px-2 py-0.5 rounded text-xs font-medium capitalize",
                            actionColors[a] || actionColors.none
                          )}
                        >
                          {a}
                        </span>
                      ))}
                    </div>
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

      {aiMessageModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAiMessageModal(null);
          }}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative w-full max-w-2xl rounded-2xl bg-white shadow-xl border border-surface-200 overflow-hidden">
            <div className="flex items-start justify-between gap-4 p-5 border-b border-surface-100">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-surface-900">
                  AI Message
                </div>
                <div className="mt-1 text-xs text-surface-500">
                  {format(new Date(aiMessageModal.created_at), "MMM d, HH:mm:ss")} ·{" "}
                  <span className="capitalize">{aiMessageModal.platform}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAiMessageModal(null)}
                className="shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium text-surface-600 hover:bg-surface-100"
              >
                Close
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="text-xs font-semibold text-surface-500 uppercase tracking-wider">
                Original Message
              </div>
              <div className="text-sm text-surface-800 whitespace-pre-wrap break-words bg-surface-50 border border-surface-200 rounded-xl p-4 max-h-40 overflow-auto">
                {aiMessageModal.message_text || "—"}
              </div>
              <div className="text-xs font-semibold text-surface-500 uppercase tracking-wider">
                AI Response
              </div>
              <div className="text-sm text-surface-800 whitespace-pre-wrap break-words bg-surface-50 border border-surface-200 rounded-xl p-4 max-h-[50vh] overflow-auto">
                {aiMessageModal.ai_message || "—"}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
