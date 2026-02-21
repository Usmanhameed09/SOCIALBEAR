import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth-helper";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createAdminClient();

    // Fetch config
    const { data: config } = await supabase
      .from("moderation_config")
      .select(
        "confidence_threshold, enabled_categories, auto_hide_enabled, dry_run_mode, ai_model"
      )
      .eq("user_id", user.id)
      .single();

    // Fetch active keywords
    const { data: keywords } = await supabase
      .from("keyword_rules")
      .select("id, keyword, action, is_active")
      .eq("user_id", user.id)
      .eq("is_active", true);

    // Fetch active category count
    let activeCategoryCount = 0;
    try {
      const { count } = await supabase
        .from("moderation_categories")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("is_active", true);
      activeCategoryCount = count || 0;
    } catch {
      // Table may not exist yet
    }

    if (!config) {
      return NextResponse.json(
        { error: "Config not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      keywords: keywords || [],
      threshold: config.confidence_threshold,
      enabled_categories: config.enabled_categories,
      auto_hide_enabled: config.auto_hide_enabled,
      dry_run_mode: config.dry_run_mode,
      ai_model: config.ai_model || "gpt-4o-mini",
      active_ai_categories: activeCategoryCount,
    });
  } catch (err) {
    console.error("Config API error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
