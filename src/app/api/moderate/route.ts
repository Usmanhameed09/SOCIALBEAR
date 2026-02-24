import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth-helper";
import { createAdminClient } from "@/lib/supabase-admin";
import OpenAI from "openai";

// Rate limiter
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Build the GPT-4o system prompt from enabled categories
function buildModerationPrompt(categories: Array<{ key: string; label: string; description: string }>) {
  const categoryList = categories
    .map((c) => `- "${c.key}": ${c.label} — ${c.description}`)
    .join("\n");

  return `You are a content moderation AI. Analyze the given social media comment and classify it against these moderation categories:

${categoryList}

For EACH category, output a confidence score between 0.0 and 1.0.
- 0.0 = definitely does not match
- 0.5 = possibly matches
- 1.0 = definitely matches

Also determine the single highest-risk category and whether the overall message should be flagged.

Respond ONLY in this exact JSON format, no other text:
{
  "flagged": true/false,
  "highest_category": "category_key",
  "highest_score": 0.0,
  "scores": {
    "category_key": 0.0,
    ...
  },
  "reason": "Brief explanation of why flagged or not"
}`;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!checkRateLimit(user.id)) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const body = await req.json();
    const { message_text, message_id, platform } = body;

    if (!message_text) {
      return NextResponse.json({ error: "message_text is required" }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Fetch user config
    const { data: config } = await supabase
      .from("moderation_config")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (!config) {
      return NextResponse.json({ error: "Config not found" }, { status: 404 });
    }

    // Fetch active keyword rules
    const { data: keywords } = await supabase
      .from("keyword_rules")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true);

    // Fetch active moderation categories
    const { data: categories } = await supabase
      .from("moderation_categories")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true);

    // ===== 1. KEYWORD CHECK (instant) =====
    const lowerText = message_text.toLowerCase();
    const matchedKeyword = keywords?.find((k: { keyword: string }) =>
      lowerText.includes(k.keyword.toLowerCase())
    );

    if (matchedKeyword) {
      const wantsHide =
        (matchedKeyword.action === "auto_hide" || matchedKeyword.action === "both") &&
        config.auto_hide_enabled &&
        !config.dry_run_mode;
      const action = wantsHide ? "hide" : "badge";
      const should_complete = !!(config.auto_complete_enabled && !config.dry_run_mode);

      const { data: inserted } = await supabase
        .from("moderation_logs")
        .insert({
          user_id: user.id,
          message_text: message_text.substring(0, 500),
          message_id: message_id || null,
          platform: platform || "unknown",
          classification: {},
          matched_keyword: matchedKeyword.keyword,
          action_taken: action === "hide" ? "hidden" : "flagged",
          confidence: 1.0,
          rule_triggered: `keyword:${matchedKeyword.keyword}`,
        })
        .select("id")
        .single();

      return NextResponse.json({
        categories: {},
        scores: {},
        flagged: true,
        action,
        should_complete,
        matched_keyword: matchedKeyword.keyword,
        confidence: 1.0,
        log_id: inserted?.id || null,
      });
    }

    // ===== 2. AI MODERATION =====
    if (!config.openai_api_key) {
      return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: config.openai_api_key });

    // Build category list for the prompt
    const activeCats = categories && categories.length > 0
      ? categories
      : getDefaultCategories();

    const systemPrompt = buildModerationPrompt(activeCats);

    let aiResult: {
      flagged: boolean;
      highest_category: string;
      highest_score: number;
      scores: Record<string, number>;
      reason: string;
    };

    try {
      const completion = await openai.chat.completions.create({
        model: config.ai_model || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Analyze this social media comment:\n\n"${message_text}"` },
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: "json_object" },
      });

      const raw = completion.choices[0]?.message?.content || "{}";
      aiResult = JSON.parse(raw);
    } catch (err) {
      console.error("OpenAI API error:", err);

      // Fallback: try basic moderation API
      try {
        const modResponse = await openai.moderations.create({ input: message_text });
        const result = modResponse.results[0];
        const scores = result.category_scores;
        let highestScore = 0;
        let highestCat = "";
        for (const cat in scores) {
          const score = scores[cat as keyof typeof scores] ?? 0;
          if (score > highestScore) {
            highestScore = score;
            highestCat = cat;
          }
        }
        aiResult = {
          flagged: highestScore >= config.confidence_threshold,
          highest_category: highestCat,
          highest_score: highestScore,
          scores: Object.fromEntries(
            Object.entries(scores).map(([k, v]) => [k, v ?? 0])
          ),
          reason: "Fallback to basic moderation API",
        };
      } catch (fallbackErr) {
        console.error("Fallback moderation also failed:", fallbackErr);
        await supabase.from("moderation_logs").insert({
          user_id: user.id,
          message_text: message_text.substring(0, 500),
          message_id: message_id || null,
          platform: platform || "unknown",
          classification: { error: "API failed" },
          action_taken: "none",
          confidence: 0,
          rule_triggered: "ai:error",
        });
        return NextResponse.json(
          { error: "AI moderation failed", action: "none", flagged: false },
          { status: 502 }
        );
      }
    }

    // Apply threshold
    let flagged = false;
    
    // Check against per-category thresholds
    for (const [key, score] of Object.entries(aiResult.scores)) {
        const cat = activeCats.find((c: { key: string; confidence_threshold?: number }) => c.key === key);
        // Default to global config if no specific threshold found
        const threshold = cat?.confidence_threshold ?? config.confidence_threshold;
        
        if (score >= threshold) {
            flagged = true;
        }
    }

    // Update highest triggered category logic
    if (flagged) {
        // Find the category with the highest score that exceeded its threshold
        let maxScore = -1;
        let maxCat = "";
        
        for (const [key, score] of Object.entries(aiResult.scores)) {
             const cat = activeCats.find((c: { key: string; confidence_threshold?: number }) => c.key === key);
             const threshold = cat?.confidence_threshold ?? config.confidence_threshold;
             
             if (score >= threshold && score > maxScore) {
                 maxScore = score;
                 maxCat = key;
             }
        }
        
        if (maxCat) {
            aiResult.highest_category = maxCat;
            aiResult.highest_score = maxScore;
        }
    } else {
        // If not flagged, ensure we still have valid highest stats (just below threshold)
        flagged = false;
    }

    let action: "hide" | "badge" | "none" = "none";
    const should_complete = !!(flagged && config.auto_complete_enabled && !config.dry_run_mode);

    if (flagged) {
      if (config.auto_hide_enabled && !config.dry_run_mode) {
        action = "hide";
      } else {
        action = "badge";
      }
    }

    // Log
    const { data: insertedAi } = await supabase
      .from("moderation_logs")
      .insert({
        user_id: user.id,
        message_text: message_text.substring(0, 500),
        message_id: message_id || null,
        platform: platform || "unknown",
        classification: aiResult.scores || {},
        action_taken: action === "hide" ? "hidden" : flagged ? "flagged" : "none",
        confidence: aiResult.highest_score || 0,
        rule_triggered: flagged ? `ai:${aiResult.highest_category}` : null,
      })
      .select("id")
      .single();

    return NextResponse.json({
      categories: aiResult.scores || {},
      scores: aiResult.scores || {},
      flagged,
      action,
      should_complete,
      confidence: aiResult.highest_score || 0,
      highest_category: aiResult.highest_category || "",
      reason: aiResult.reason || "",
      log_id: insertedAi?.id || null,
    });
  } catch (err) {
    console.error("Moderate API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Default categories if user hasn't configured custom ones
function getDefaultCategories() {
  return [
    { key: "profanity", label: "General Profanity", description: "Swear words, vulgar language, offensive slang", confidence_threshold: 0.8 },
    { key: "lgbtqia_attack", label: "LGBTQIA+ Attack", description: "Homophobic, transphobic, or anti-LGBTQIA+ language", confidence_threshold: 0.8 },
    { key: "violent_language", label: "Violent Language", description: "Threats of violence, glorification of violence, aggressive language", confidence_threshold: 0.8 },
    { key: "racism", label: "Racism", description: "Racial slurs, discriminatory language, xenophobia", confidence_threshold: 0.8 },
    { key: "boycott_criticism", label: "Boycott & Criticism", description: "Overtly critical language designed to build an agenda against the brand, calls for boycotts", confidence_threshold: 0.8 },
    { key: "fat_shaming", label: "Fat Shaming", description: "Body shaming, mocking weight, demeaning comments about body size", confidence_threshold: 0.8 },
    { key: "eating_disorder", label: "Eating Disorder Shaming", description: "Mocking eating disorders, promoting unhealthy eating, triggering ED content", confidence_threshold: 0.8 },
    { key: "ev_hostility", label: "EV Hostility", description: "Hostile language about electric vehicles, anti-EV propaganda", confidence_threshold: 0.8 },
    { key: "greenwashing", label: "Greenwashing Allegations", description: "Accusations of false environmental claims, eco-fraud allegations", confidence_threshold: 0.8 },
    { key: "nature_wars", label: "Nature Wars", description: "Hostile debates about nature, gardening conflicts, environmental extremism", confidence_threshold: 0.8 },
    { key: "elitism", label: "Elitism", description: "Classist remarks, snobbery, looking down on others based on social status", confidence_threshold: 0.8 },
    { key: "paedophilia", label: "Paedophilia", description: "Any content sexualizing children, grooming language, child exploitation", confidence_threshold: 0.8 },
    { key: "parent_shaming", label: "Parent Shaming", description: "Attacking parenting choices, mom/dad shaming, parental guilt-tripping", confidence_threshold: 0.8 },
    { key: "classism", label: "Classism", description: "Discrimination based on social class, wealth-based mockery", confidence_threshold: 0.8 },
    { key: "child_abuse", label: "Child Abuse", description: "References to child abuse, neglect, or endangerment", confidence_threshold: 0.8 },
    { key: "sexual_content", label: "Sexual Content", description: "Sexually explicit language, inappropriate sexual references", confidence_threshold: 0.8 },
    { key: "spam", label: "Spam", description: "Promotional spam, scam links, bot-generated content", confidence_threshold: 0.8 },
  ];
}
