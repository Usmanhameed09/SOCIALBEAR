"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase-browser";
import { KeywordRule } from "@/lib/types";
import {
  Plus,
  Trash2,
  Search,
  RefreshCw,
  KeyRound,
  EyeOff,
  Tag,
  X,
} from "lucide-react";
import clsx from "clsx";

export default function KeywordsPage() {
  const [keywords, setKeywords] = useState<KeywordRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [newAction, setNewAction] = useState<"badge_only" | "auto_hide" | "both">(
    "badge_only"
  );
  const [saving, setSaving] = useState(false);
  const supabase = createClient();

  const fetchKeywords = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("keyword_rules")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (data) setKeywords(data);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchKeywords();
  }, [fetchKeywords]);

  const addKeyword = async () => {
    if (!newKeyword.trim()) return;
    setSaving(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase.from("keyword_rules").insert({
      user_id: user.id,
      keyword: newKeyword.trim().toLowerCase(),
      action: newAction,
      is_active: true,
    });

    if (!error) {
      setNewKeyword("");
      setShowAdd(false);
      fetchKeywords();
    }
    setSaving(false);
  };

  const deleteKeyword = async (id: string) => {
    await supabase.from("keyword_rules").delete().eq("id", id);
    setKeywords((prev) => prev.filter((k) => k.id !== id));
  };

  const toggleActive = async (id: string, currentState: boolean) => {
    await supabase
      .from("keyword_rules")
      .update({ is_active: !currentState })
      .eq("id", id);
    setKeywords((prev) =>
      prev.map((k) => (k.id === id ? { ...k, is_active: !currentState } : k))
    );
  };

  const filteredKeywords = keywords.filter((k) =>
    k.keyword.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-surface-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 tracking-tight">
            Keyword Rules
          </h1>
          <p className="text-surface-500 text-sm mt-1">
            Instant matching — no API call needed
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-xl text-sm transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Add Keyword
        </button>
      </div>

      {/* Add Keyword Modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-white rounded-2xl border border-surface-200 p-6 w-full max-w-md shadow-2xl animate-slide-up">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-surface-900">
                Add Keyword Rule
              </h3>
              <button
                onClick={() => setShowAdd(false)}
                className="p-1.5 hover:bg-surface-100 rounded-lg text-surface-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1.5">
                  Keyword or phrase
                </label>
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  className="w-full px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 text-sm"
                  placeholder="e.g., buy now, click here, free money"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1.5">
                  Action
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <button
                    onClick={() => setNewAction("badge_only")}
                    className={clsx(
                      "flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-all",
                      newAction === "badge_only"
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-surface-200 text-surface-600 hover:border-surface-300"
                    )}
                  >
                    <Tag className="w-4 h-4" />
                    Badge Only
                  </button>
                  <button
                    onClick={() => setNewAction("auto_hide")}
                    className={clsx(
                      "flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-all",
                      newAction === "auto_hide"
                        ? "border-danger-500 bg-danger-50 text-danger-700"
                        : "border-surface-200 text-surface-600 hover:border-surface-300"
                    )}
                  >
                    <EyeOff className="w-4 h-4" />
                    Auto-Hide
                  </button>
                  <button
                    onClick={() => setNewAction("both")}
                    className={clsx(
                      "flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-all",
                      newAction === "both"
                        ? "border-purple-500 bg-purple-50 text-purple-700"
                        : "border-surface-200 text-surface-600 hover:border-surface-300"
                    )}
                  >
                    <Tag className="w-4 h-4" />
                    Badge + Hide
                  </button>
                </div>
              </div>

              <button
                onClick={addKeyword}
                disabled={!newKeyword.trim() || saving}
                className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white font-medium rounded-xl text-sm transition-colors"
              >
                {saving ? "Adding..." : "Add Rule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-white border border-surface-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 text-sm"
          placeholder="Search keywords..."
        />
      </div>

      {/* Keywords List */}
      {filteredKeywords.length === 0 ? (
        <div className="bg-white rounded-2xl border border-surface-200/80 p-12 text-center">
          <KeyRound className="w-10 h-10 text-surface-300 mx-auto mb-3" />
          <p className="text-surface-500 text-sm">
            {keywords.length === 0
              ? "No keyword rules yet. Add one to get started."
              : "No keywords match your search."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredKeywords.map((rule, i) => (
            <div
              key={rule.id}
              className="bg-white rounded-xl border border-surface-200/80 px-5 py-4 flex items-center justify-between hover:shadow-sm transition-shadow animate-slide-up"
              style={{ animationDelay: `${i * 30}ms` }}
            >
              <div className="flex items-center gap-4">
                {/* Toggle */}
                <button
                  onClick={() => toggleActive(rule.id, rule.is_active)}
                  className={clsx("toggle-switch", rule.is_active && "active")}
                />

                {/* Keyword */}
                <div>
                  <span
                    className={clsx(
                      "font-mono text-sm font-medium",
                      rule.is_active
                        ? "text-surface-900"
                        : "text-surface-400 line-through"
                    )}
                  >
                    {rule.keyword}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {/* Action badge */}
                <span
                  className={clsx(
                    "px-2.5 py-1 rounded-lg text-xs font-medium",
                    rule.action === "auto_hide"
                      ? "bg-danger-50 text-danger-600"
                      : rule.action === "both"
                      ? "bg-purple-50 text-purple-700"
                      : "bg-blue-50 text-blue-600"
                  )}
                >
                  {rule.action === "auto_hide"
                    ? "Auto-Hide"
                    : rule.action === "both"
                    ? "Badge + Hide"
                    : "Badge Only"}
                </span>

                {/* Delete */}
                <button
                  onClick={() => deleteKeyword(rule.id)}
                  className="p-1.5 hover:bg-danger-50 rounded-lg text-surface-400 hover:text-danger-500 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-surface-400 mt-4">
        {keywords.length} keyword{keywords.length !== 1 ? "s" : ""} total ·{" "}
        {keywords.filter((k) => k.is_active).length} active
      </p>
    </div>
  );
}
