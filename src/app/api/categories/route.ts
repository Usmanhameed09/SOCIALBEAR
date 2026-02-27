import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth-helper";
import { createAdminClient } from "@/lib/supabase-admin";

function normalizeCategoryKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function displayLabelFromKey(key: string) {
  const acronyms = new Map<string, string>([
    ["ai", "AI"],
    ["ev", "EV"],
    ["lgbtqia", "LGBTQIA"],
  ]);
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => {
      const normalized = part.toLowerCase();
      const acr = acronyms.get(normalized);
      if (acr) return acr;
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join(" ");
}

function parseBulkCategoryText(text: string) {
  const normalized = (text || "").trim();
  if (!normalized) return { items: [], errors: ["bulk_text is empty"] };

  const matches = Array.from(
    normalized.matchAll(
      /\(\s*label\s*:\s*([^,]+?)\s*,\s*threshold\s*:\s*([0-9]*\.?[0-9]+)\s*\)\s*\.\s*/gi
    )
  );

  if (matches.length === 0) {
    return {
      items: [],
      errors: ['No entries found. Expected format like "(label: spam, threshold: 0.85). Description"'],
    };
  }

  const errors: string[] = [];
  const items: Array<{ key: string; threshold: number; description: string }> = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const labelRaw = String(m[1] || "");
    const thresholdRaw = String(m[2] || "");
    const threshold = Number(thresholdRaw);
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? normalized.length) : normalized.length;
    const description = normalized.slice(start, end).trim();
    const key = normalizeCategoryKey(labelRaw);

    if (!key) {
      errors.push(`Invalid label: "${labelRaw}"`);
      continue;
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      errors.push(`Invalid threshold for "${key}": "${thresholdRaw}" (expected 0.0–1.0)`);
      continue;
    }
    if (!description) {
      errors.push(`Missing description for "${key}"`);
      continue;
    }

    items.push({ key, threshold, description });
  }

  const deduped = new Map<string, { key: string; threshold: number; description: string }>();
  for (const item of items) deduped.set(item.key, item);

  return { items: Array.from(deduped.values()), errors };
}

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
    if (typeof body?.bulk_text === "string") {
      const parsed = parseBulkCategoryText(body.bulk_text);
      if (parsed.errors.length > 0) {
        return NextResponse.json(
          { error: "Invalid bulk_text", details: parsed.errors },
          { status: 400 }
        );
      }

      const supabase = createAdminClient();
      const { data: existing, error: existingErr } = await supabase
        .from("moderation_categories")
        .select("id, key, label, sort_order, is_active")
        .eq("user_id", user.id);

      if (existingErr) throw existingErr;

      const existingByKey = new Map<string, { id: string; key: string; label: string; sort_order: number | null }>();
      for (const row of existing || []) {
        existingByKey.set(row.key, {
          id: row.id,
          key: row.key,
          label: row.label,
          sort_order: row.sort_order ?? null,
        });
      }

      let maxSortOrder = 0;
      for (const row of existing || []) {
        const s = Number(row.sort_order) || 0;
        if (s > maxSortOrder) maxSortOrder = s;
      }

      let updated = 0;
      const inserts: Array<{
        user_id: string;
        key: string;
        label: string;
        description: string;
        is_active: boolean;
        sort_order: number;
        confidence_threshold: number;
      }> = [];

      for (const item of parsed.items) {
        const found = existingByKey.get(item.key);
        if (found) {
          const { error: updateErr } = await supabase
            .from("moderation_categories")
            .update({
              description: item.description,
              confidence_threshold: item.threshold,
              is_active: true,
            })
            .eq("id", found.id)
            .eq("user_id", user.id);
          if (updateErr) throw updateErr;
          updated++;
        } else {
          maxSortOrder += 1;
          inserts.push({
            user_id: user.id,
            key: item.key,
            label: displayLabelFromKey(item.key),
            description: item.description,
            is_active: true,
            sort_order: maxSortOrder,
            confidence_threshold: item.threshold,
          });
        }
      }

      let inserted = 0;
      if (inserts.length > 0) {
        const { error: insertErr } = await supabase.from("moderation_categories").insert(inserts);
        if (insertErr) throw insertErr;
        inserted = inserts.length;
      }

      return NextResponse.json({
        success: true,
        updated,
        inserted,
        keys: parsed.items.map((i) => i.key),
      });
    }

    const { key, label, description, is_active, sort_order, confidence_threshold } = body;

    if (!key || !label) {
      return NextResponse.json({ error: "key and label required" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("moderation_categories")
      .insert({
        user_id: user.id,
        key: normalizeCategoryKey(String(key)),
        label,
        description: description || "",
        is_active: is_active !== false,
        sort_order: sort_order || 99,
        confidence_threshold: confidence_threshold || 0.8,
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
    const { id, label, description, is_active, sort_order, confidence_threshold } = body;

    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = createAdminClient();
    const update: Record<string, unknown> = {};
    if (label !== undefined) update.label = label;
    if (description !== undefined) update.description = description;
    if (is_active !== undefined) update.is_active = is_active;
    if (sort_order !== undefined) update.sort_order = sort_order;
    if (confidence_threshold !== undefined) update.confidence_threshold = confidence_threshold;

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
