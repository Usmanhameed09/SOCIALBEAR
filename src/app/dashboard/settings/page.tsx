"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase-browser";
import { ModerationConfig } from "@/lib/types";
import {
  Save,
  RefreshCw,
  Eye,
  EyeOff,
  AlertTriangle,
  CheckCircle2,
  Shield,
  CircleCheck,
} from "lucide-react";
import clsx from "clsx";

export default function SettingsPage() {
  const [config, setConfig] = useState<ModerationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const supabase = createClient();

  const fetchConfig = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("moderation_config")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (data) setConfig(data);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);

    const { error } = await supabase
      .from("moderation_config")
      .update({
        openai_api_key: config.openai_api_key,
        auto_hide_enabled: config.auto_hide_enabled,
        auto_complete_enabled: config.auto_complete_enabled ?? false,
        dry_run_mode: config.dry_run_mode,
        confidence_threshold: config.confidence_threshold,
        enabled_categories: config.enabled_categories,
        ai_model: config.ai_model || "gpt-4o-mini",
        updated_at: new Date().toISOString(),
      })
      .eq("id", config.id);

    setSaving(false);
    if (!error) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  };

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-surface-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 tracking-tight">
            AI Settings
          </h1>
          <p className="text-surface-500 text-sm mt-1">
            Configure AI moderation actions, thresholds, and API access.
            Keyword actions are configured per-keyword on the Keywords page.
          </p>
        </div>
        <button
          onClick={saveConfig}
          disabled={saving}
          className={clsx(
            "flex items-center gap-2 px-5 py-2.5 font-medium rounded-xl text-sm transition-all shadow-sm",
            saved
              ? "bg-brand-500 text-white"
              : "bg-brand-500 hover:bg-brand-600 text-white"
          )}
        >
          {saving ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : saved ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
        </button>
      </div>

      <div className="space-y-6">
        {/* ========== AI MODERATION ACTIONS ========== */}
        <div className="bg-white rounded-2xl border border-surface-200/80 p-6">
          <h3 className="text-sm font-semibold text-surface-900 mb-1">
            AI Moderation Actions
          </h3>
          <p className="text-xs text-surface-400 mb-5">
            When AI flags a comment above the confidence threshold, which
            actions should be performed? These only apply to AI-flagged content
            — keyword actions are set independently per keyword.
          </p>

          <div className="space-y-4">
            {/* Auto-Hide */}
            <div className="flex items-center justify-between py-3 border-b border-surface-100">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-danger-50 flex items-center justify-center">
                  <EyeOff className="w-4 h-4 text-danger-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-surface-900">Auto-Hide</p>
                  <p className="text-xs text-surface-400">
                    Automatically hide AI-flagged comments on the platform
                  </p>
                </div>
              </div>
              <button
                onClick={() =>
                  setConfig({ ...config, auto_hide_enabled: !config.auto_hide_enabled })
                }
                className={clsx("toggle-switch", config.auto_hide_enabled && "active")}
              />
            </div>

            {/* Auto-Complete */}
            <div className="flex items-center justify-between py-3 border-b border-surface-100">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">
                  <CircleCheck className="w-4 h-4 text-green-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-surface-900">Auto-Complete</p>
                  <p className="text-xs text-surface-400">
                    Mark AI-flagged comments as &quot;Complete&quot; in Sprout inbox
                  </p>
                </div>
              </div>
              <button
                onClick={() =>
                  setConfig({
                    ...config,
                    auto_complete_enabled: !(config.auto_complete_enabled ?? false),
                  })
                }
                className={clsx(
                  "toggle-switch",
                  (config.auto_complete_enabled ?? false) && "active"
                )}
              />
            </div>

            {/* Dry-Run */}
            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-warning-50 flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4 text-warning-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-surface-900">Dry-Run Mode</p>
                  <p className="text-xs text-surface-400">
                    AI classifies &amp; badges only — no hide or complete actions
                  </p>
                </div>
              </div>
              <button
                onClick={() =>
                  setConfig({ ...config, dry_run_mode: !config.dry_run_mode })
                }
                className={clsx("toggle-switch", config.dry_run_mode && "active")}
              />
            </div>
          </div>

          {/* Active summary */}
          <div className="mt-4 p-3 bg-brand-50 border border-brand-100 rounded-xl">
            <p className="text-xs text-brand-700">
              <span className="font-medium">Active AI actions:</span>{" "}
              {config.dry_run_mode
                ? "Badge only (Dry-Run active)"
                : [
                    "Badge",
                    config.auto_hide_enabled && "Auto-Hide",
                    (config.auto_complete_enabled ?? false) && "Auto-Complete",
                  ]
                    .filter(Boolean)
                    .join(" + ")}
            </p>
          </div>

          {config.dry_run_mode && (
            <div className="mt-3 p-3 bg-warning-50 border border-warning-100 rounded-xl flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning-500 flex-shrink-0" />
              <p className="text-xs text-warning-700">
                Dry-run active. AI will classify and badge but won&apos;t
                auto-hide or auto-complete. Keyword actions are NOT affected.
              </p>
            </div>
          )}
        </div>

        {/* ========== API KEY ========== */}
        <div className="bg-white rounded-2xl border border-surface-200/80 p-6">
          <h3 className="text-sm font-semibold text-surface-900 mb-1">OpenAI API Key</h3>
          <p className="text-xs text-surface-400 mb-4">
            Used server-side for AI classification. Never exposed to the extension.
          </p>
          <div className="relative">
            <input
              type={showApiKey ? "text" : "password"}
              value={config.openai_api_key}
              onChange={(e) => setConfig({ ...config, openai_api_key: e.target.value })}
              className="w-full px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 text-sm font-mono pr-12"
              placeholder="sk-..."
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600"
            >
              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* ========== AI MODEL ========== */}
        <div className="bg-white rounded-2xl border border-surface-200/80 p-6">
          <h3 className="text-sm font-semibold text-surface-900 mb-1">AI Model</h3>
          <p className="text-xs text-surface-400 mb-4">
            GPT-4o is more accurate. GPT-4o-mini is faster and cheaper.
          </p>
          <select
            value={config.ai_model || "gpt-4o-mini"}
            onChange={(e) => setConfig({ ...config, ai_model: e.target.value })}
            className="w-full px-4 py-2.5 border border-surface-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 text-sm bg-white"
          >
            <option value="gpt-4o-mini">GPT-4o Mini — Faster, lower cost</option>
            <option value="gpt-4o">GPT-4o — More accurate, best for nuanced categories</option>
            <option value="gpt-4-turbo">GPT-4 Turbo — High accuracy, higher cost</option>
          </select>
        </div>

        {/* ========== CONFIDENCE THRESHOLD ========== */}
        <div className="bg-white rounded-2xl border border-surface-200/80 p-6">
          <h3 className="text-sm font-semibold text-surface-900 mb-1">Confidence Threshold</h3>
          <p className="text-xs text-surface-400 mb-4">
            AI-flagged messages scoring above this will trigger the actions above.
          </p>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={config.confidence_threshold}
              onChange={(e) =>
                setConfig({ ...config, confidence_threshold: parseFloat(e.target.value) })
              }
              className="flex-1 h-2 bg-surface-200 rounded-full appearance-none cursor-pointer accent-brand-500"
            />
            <span className="text-lg font-bold font-mono text-surface-900 w-16 text-right">
              {(config.confidence_threshold * 100).toFixed(0)}%
            </span>
          </div>
          <div className="flex justify-between text-[10px] text-surface-400 mt-1 px-1">
            <span>Sensitive (10%)</span>
            <span>Balanced (50%)</span>
            <span>Strict (100%)</span>
          </div>
        </div>

        {/* ========== CATEGORIES ========== */}
        <div className="bg-white rounded-2xl border border-surface-200/80 p-6">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-surface-400" />
            <h3 className="text-sm font-semibold text-surface-900">AI Moderation Categories</h3>
          </div>
          <p className="text-xs text-surface-400 mb-4">
            Categories are managed with custom AI prompts on a dedicated page.
          </p>
          <a
            href="/dashboard/categories"
            className="inline-flex items-center gap-2 bg-brand-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 transition-colors"
          >
            <Shield className="w-4 h-4" />
            Manage AI Categories
          </a>
        </div>
      </div>
    </div>
  );
}