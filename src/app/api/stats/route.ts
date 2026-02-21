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

    const { data, error } = await supabase.rpc("get_dashboard_stats", {
      p_user_id: user.id,
    });

    if (error) {
      return NextResponse.json(
        { error: "Failed to fetch stats" },
        { status: 500 }
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error("Stats API error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
