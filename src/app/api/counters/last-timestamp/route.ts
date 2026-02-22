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
    const { data, error } = await supabase
      .from("moderation_counters")
      .select("last_checked_timestamp")
      .eq("user_id", user.id)
      .single();

    if (error && error.code !== "PGRST116") {
      return NextResponse.json(
        { error: "Failed to fetch timestamp", details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      last_checked_timestamp: data?.last_checked_timestamp ?? 0,
    });
  } catch (err) {
    console.error("Error in GET /api/counters/last-timestamp:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { last_checked_timestamp } = body;

    if (typeof last_checked_timestamp !== "number") {
      return NextResponse.json(
        { error: "Invalid last_checked_timestamp, must be a number" },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Update only if new value is greater than existing, or if existing is null
    // We use .or() to handle both conditions combined with the user_id check
    const { error } = await supabase
      .from("moderation_counters")
      .update({ last_checked_timestamp })
      .eq("user_id", user.id)
      .or(`last_checked_timestamp.lt.${last_checked_timestamp},last_checked_timestamp.is.null`);

    if (error) {
      return NextResponse.json(
        { error: "Failed to update timestamp", details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Error in POST /api/counters/last-timestamp:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
