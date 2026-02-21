import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth-helper";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const {
      total_processed,
      flagged_current,
      auto_hidden_increment,
      completed_increment,
      flagged_total,
      auto_hidden_total,
      completed_total,
    } = body as {
      total_processed?: number;
      flagged_current?: number;
      auto_hidden_increment?: number;
      completed_increment?: number;
      flagged_total?: number;
      auto_hidden_total?: number;
      completed_total?: number;
    };

    const supabase = createAdminClient();

    const { data: existing, error: selectErr } = await supabase
      .from("moderation_counters")
      .select("total_processed, flagged, auto_hidden, completed")
      .eq("user_id", user.id)
      .single();

    if (selectErr && selectErr.code !== "PGRST116") {
      return NextResponse.json(
        { error: "Failed to read counters", code: selectErr.code, details: selectErr.message },
        { status: 500 }
      );
    }

    const nextValues = {
      user_id: user.id,
      total_processed:
        typeof total_processed === "number"
          ? total_processed
          : existing?.total_processed ?? 0,
      flagged:
        typeof flagged_total === "number"
          ? flagged_total
          : typeof flagged_current === "number"
          ? flagged_current
          : existing?.flagged ?? 0,
      auto_hidden:
        typeof auto_hidden_total === "number"
          ? auto_hidden_total
          : (existing?.auto_hidden ?? 0) + (auto_hidden_increment ?? 0),
      completed:
        typeof completed_total === "number"
          ? completed_total
          : (existing?.completed ?? 0) + (completed_increment ?? 0),
      updated_at: new Date().toISOString(),
    };

    // Upsert by user_id
    const { error: upsertErr } = await supabase
      .from("moderation_counters")
      .upsert(nextValues, { onConflict: "user_id" });

    if (upsertErr) {
      return NextResponse.json(
        { error: "Failed to update counters", code: upsertErr.code, details: upsertErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Counters API error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
