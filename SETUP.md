# Sprout Social AI Moderation Panel — Setup Guide

## 1. Prerequisites
- Node.js 18+ installed
- A Supabase account (https://supabase.com)
- An OpenAI API key
- A Vercel account (for deployment)

## 2. Create Next.js Project From Scratch

```bash
npx create-next-app@latest sprout-moderation-panel \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --import-alias "@/*"

cd sprout-moderation-panel
```

## 3. Install Dependencies

```bash
npm install @supabase/supabase-js @supabase/ssr openai lucide-react clsx date-fns
npm install -D @types/node
```

## 4. Supabase Setup

### 4a. Create a new Supabase project at https://supabase.com

### 4b. Run this SQL in Supabase SQL Editor:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Moderation config table
CREATE TABLE moderation_config (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  openai_api_key TEXT DEFAULT '',
  auto_hide_enabled BOOLEAN DEFAULT false,
  dry_run_mode BOOLEAN DEFAULT true,
  confidence_threshold FLOAT DEFAULT 0.7,
  enabled_categories JSONB DEFAULT '["hate","harassment","spam","self-harm","sexual","violence"]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Keyword rules table
CREATE TABLE keyword_rules (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  action TEXT DEFAULT 'badge_only' CHECK (action IN ('badge_only', 'auto_hide')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Moderation logs table
CREATE TABLE moderation_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  message_text TEXT,
  message_id TEXT,
  platform TEXT DEFAULT 'unknown',
  classification JSONB DEFAULT '{}'::jsonb,
  matched_keyword TEXT,
  action_taken TEXT DEFAULT 'none' CHECK (action_taken IN ('flagged', 'hidden', 'completed', 'none')),
  confidence FLOAT DEFAULT 0,
  rule_triggered TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_moderation_logs_user_id ON moderation_logs(user_id);
CREATE INDEX idx_moderation_logs_created_at ON moderation_logs(created_at DESC);
CREATE INDEX idx_moderation_logs_platform ON moderation_logs(platform);
CREATE INDEX idx_moderation_logs_action ON moderation_logs(action_taken);
CREATE INDEX idx_keyword_rules_user_id ON keyword_rules(user_id);

-- Row Level Security
ALTER TABLE moderation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can manage own config"
  ON moderation_config FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage own keywords"
  ON keyword_rules FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage own logs"
  ON moderation_logs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Function to auto-create config on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.moderation_config (user_id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to get dashboard stats
CREATE OR REPLACE FUNCTION get_dashboard_stats(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'total_processed', (SELECT COUNT(*) FROM moderation_logs WHERE user_id = p_user_id),
    'total_hidden', (SELECT COUNT(*) FROM moderation_logs WHERE user_id = p_user_id AND action_taken = 'hidden'),
    'total_flagged', (SELECT COUNT(*) FROM moderation_logs WHERE user_id = p_user_id AND action_taken = 'flagged'),
    'total_completed', (SELECT COUNT(*) FROM moderation_logs WHERE user_id = p_user_id AND action_taken = 'completed'),
    'today_processed', (SELECT COUNT(*) FROM moderation_logs WHERE user_id = p_user_id AND created_at >= CURRENT_DATE),
    'today_hidden', (SELECT COUNT(*) FROM moderation_logs WHERE user_id = p_user_id AND action_taken = 'hidden' AND created_at >= CURRENT_DATE),
    'last_processed', (SELECT MAX(created_at) FROM moderation_logs WHERE user_id = p_user_id),
    'active_keywords', (SELECT COUNT(*) FROM keyword_rules WHERE user_id = p_user_id AND is_active = true)
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4c. In Supabase Dashboard → Authentication → Settings:
- Enable Email auth
- Disable "Confirm email" for testing (optional)

## 5. Environment Variables

Create `.env.local` in project root:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

Find these in Supabase Dashboard → Settings → API.

## 6. Run Development Server

```bash
npm run dev
```

Visit http://localhost:3000

## 7. Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Add the same environment variables in Vercel Dashboard → Settings → Environment Variables.

## 8. Chrome Extension

The Chrome extension connects to this admin panel's API endpoints. See the `chrome-extension/` folder for the extension code.
