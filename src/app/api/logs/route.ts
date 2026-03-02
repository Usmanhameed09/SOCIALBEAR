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
    const { log_id, action_taken, message_id, message_text, platform, ai_message } = body;

    if (!action_taken) {
      return NextResponse.json({ error: "action_taken required" }, { status: 400 });
    }

    const validActions = ["flagged", "hidden", "completed", "none"];
    if (!validActions.includes(action_taken)) {
      return NextResponse.json(
        { error: "Invalid action_taken value" },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // If log_id provided, update existing entry
    if (log_id) {
      const updatePayload: Record<string, unknown> = { action_taken };
      if (typeof message_text === "string") {
        updatePayload.message_text = message_text.substring(0, 500);
      }
      if (typeof platform === "string") {
        updatePayload.platform = platform || "unknown";
      }
      if (typeof ai_message === "string") {
        updatePayload.ai_message = ai_message.substring(0, 2000);
      }

      const { error } = await supabase
        .from("moderation_logs")
        .update(updatePayload)
        .eq("id", log_id)
        .eq("user_id", user.id);

      if (error) {
        return NextResponse.json({ error: "Failed to update log" }, { status: 500 });
      }
      return NextResponse.json({ success: true, id: log_id });
    } else {
      // Special case: flagged should update/replace an existing entry for the same message
      if (action_taken === "flagged" && message_id) {
        const { data: existingList, error: findErr } = await supabase
          .from("moderation_logs")
          .select("id, action_taken")
          .eq("user_id", user.id)
          .eq("message_id", message_id)
          .neq("action_taken", "completed")
          .order("created_at", { ascending: false })
          .limit(1);

        if (!findErr && existingList && existingList.length > 0) {
          const targetId = existingList[0].id;
          const { error: updErr } = await supabase
            .from("moderation_logs")
            .update({ action_taken: "flagged" })
            .eq("id", targetId)
            .eq("user_id", user.id);
          if (!updErr) {
            return NextResponse.json({ success: true, id: targetId });
          }
        }
        // No existing entry found or update failed — fall back to creating a new row
      }

      // Otherwise, create a new log row (e.g., for 'completed')
      if (!message_id && !message_text) {
        return NextResponse.json(
          { error: "message_id or message_text required to create log" },
          { status: 400 }
        );
      }
      const { data, error } = await supabase
        .from("moderation_logs")
        .insert({
          user_id: user.id,
          message_text: (message_text || "").substring(0, 500),
          message_id: message_id || null,
          platform: platform || "unknown",
          classification: {},
          ai_message: typeof ai_message === "string" ? ai_message.substring(0, 2000) : null,
          matched_keyword: null,
          action_taken: action_taken,
          confidence: 0,
          rule_triggered: "ui:" + action_taken,
        })
        .select("id")
        .single();

      if (error) {
        return NextResponse.json({ error: "Failed to create log" }, { status: 500 });
      }
      return NextResponse.json({ success: true, id: data?.id });
    }
  } catch (err) {
    console.error("Logs API error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
