import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth-helper";
import { createAdminClient } from "@/lib/supabase-admin";

// GET — list all categories for user
export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("moderation_categories")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });

    if (error) throw error;

    // If no categories exist, seed defaults
    if (!data || data.length === 0) {
      const defaults = getDefaultCategories(user.id);
      const { data: seeded, error: seedErr } = await supabase
        .from("moderation_categories")
        .insert(defaults)
        .select();
      if (seedErr) throw seedErr;
      return NextResponse.json(seeded);
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error("Categories GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — create a new category
export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { key, label, description, is_active, sort_order } = body;

    if (!key || !label) {
      return NextResponse.json({ error: "key and label required" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("moderation_categories")
      .insert({
        user_id: user.id,
        key: key.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
        label,
        description: description || "",
        is_active: is_active !== false,
        sort_order: sort_order || 99,
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    console.error("Categories POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT — update a category
export async function PUT(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { id, label, description, is_active, sort_order } = body;

    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = createAdminClient();
    const update: Record<string, unknown> = {};
    if (label !== undefined) update.label = label;
    if (description !== undefined) update.description = description;
    if (is_active !== undefined) update.is_active = is_active;
    if (sort_order !== undefined) update.sort_order = sort_order;

    const { data, error } = await supabase
      .from("moderation_categories")
      .update(update)
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    console.error("Categories PUT error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE — remove a category
export async function DELETE(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = createAdminClient();
    const { error } = await supabase
      .from("moderation_categories")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Categories DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

function getDefaultCategories(userId: string) {
  return [
    { user_id: userId, key: "profanity", label: "General Profanity", description: "Swear words, vulgar language, offensive slang. Anything that could be deemed offensive or provide risk to your brand.", sort_order: 1, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "lgbtqia_attack", label: "LGBTQIA+ Triage", description: "Homophobic, transphobic, or anti-LGBTQIA+ attacks and language.", sort_order: 2, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "violent_language", label: "Violent Language", description: "Threats of violence, glorification of violence, aggressive language towards the post or in general.", sort_order: 3, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "racism", label: "Racism", description: "Racial slurs, discriminatory language, xenophobia, racist language towards the post or in general.", sort_order: 4, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "boycott_criticism", label: "Boycott & Criticism", description: "Overtly critical language, or language designed to build an agenda against your brands. Calls for boycotts.", sort_order: 5, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "fat_shaming", label: "Fat Shaming", description: "Body shaming, mocking weight, demeaning comments about body size. (Food & Health brands: Olive, Goodfood, Nutracheck)", sort_order: 6, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "eating_disorder", label: "Eating Disorder Shaming", description: "Mocking eating disorders, promoting unhealthy eating, triggering ED content, critical of recipes or diet advice. (Food & Health brands)", sort_order: 7, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "ev_hostility", label: "EV Hostility", description: "Hostile language about electric vehicles, anti-EV propaganda. (Lifestyle brands: Top Gear, Gardener World)", sort_order: 8, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "greenwashing", label: "Greenwashing Allegations", description: "Accusations of false environmental claims, eco-fraud allegations. (Lifestyle brands)", sort_order: 9, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "nature_wars", label: "Nature Wars", description: "Hostile debates about nature, gardening conflicts, environmental extremism. (Lifestyle brands)", sort_order: 10, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "elitism", label: "Elitism", description: "Classist remarks, snobbery, looking down on others based on social status. (Lifestyle brands)", sort_order: 11, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "paedophilia", label: "Paedophilia", description: "Any content sexualizing children, grooming language, child exploitation. (Parenting brands: MadeforMums, CBeebies)", sort_order: 12, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "parent_shaming", label: "Parent Shaming", description: "Attacking parenting choices, mom/dad shaming, parental guilt-tripping. (Parenting brands)", sort_order: 13, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "classism", label: "Classism", description: "Discrimination based on social class, wealth-based mockery. (Parenting brands)", sort_order: 14, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "child_abuse", label: "Child Abuse", description: "References to child abuse, neglect, or endangerment. (Parenting brands)", sort_order: 15, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "sexual_content", label: "Sexual Content", description: "Sexually explicit language, inappropriate sexual references.", sort_order: 16, is_active: true, confidence_threshold: 0.8 },
    { user_id: userId, key: "spam", label: "Spam", description: "Promotional spam, scam links, bot-generated content, unsolicited advertising.", sort_order: 17, is_active: true, confidence_threshold: 0.8 },
  ];
}
