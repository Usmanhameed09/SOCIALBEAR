export interface ModerationConfig {
  id: string;
  user_id: string;
  openai_api_key: string;
  auto_hide_enabled: boolean;
  dry_run_mode: boolean;
  confidence_threshold: number;
  enabled_categories: string[];
  ai_model: string;
  created_at: string;
  updated_at: string;
  auto_complete_enabled?: boolean;

}

export interface ModerationCategory {
  id: string;
  user_id: string;
  key: string;
  label: string;
  description: string;
  is_active: boolean;
  confidence_threshold: number;
  sort_order: number;
  created_at: string;
}

export interface KeywordRule {
  id: string;
  user_id: string;
  keyword: string;
  action: "badge_only" | "auto_hide" | "both";
  is_active: boolean;
  created_at: string;
}

export interface ModerationLog {
  id: string;
  user_id: string;
  message_text: string;
  message_id: string;
  platform: string;
  classification: Record<string, number>;
  ai_message?: string | null;
  matched_keyword: string | null;
  action_taken: "flagged" | "hidden" | "completed" | "none";
  confidence: number;
  rule_triggered: string | null;
  created_at: string;
}

export interface DashboardStats {
  total_processed: number;
  total_hidden: number;
  total_flagged: number;
  total_completed: number;
  today_processed: number;
  today_hidden: number;
  today_flagged: number;
  today_completed: number;
  last_processed: string | null;
  active_keywords: number;
}

export interface ModerationCounters {
  user_id: string;
  total_processed: number;
  flagged: number;
  auto_hidden: number;
  completed: number;
  last_checked_timestamp: number;
  updated_at: string;
}

export interface ModerateRequest {
  message_text: string;
  message_id: string;
  platform: string;
}

export interface ModerateResponse {
  categories: Record<string, boolean>;
  scores: Record<string, number>;
  flagged: boolean;
  action: "hide" | "badge" | "none";
  matched_keyword?: string;
  confidence: number;
}

export interface ConfigResponse {
  keywords: KeywordRule[];
  threshold: number;
  enabled_categories: string[];
  auto_hide_enabled: boolean;
  dry_run_mode: boolean;
}

export const MODERATION_CATEGORIES = [
  { key: "hate", label: "Hate Speech", color: "#ef4444" },
  { key: "harassment", label: "Harassment", color: "#f97316" },
  { key: "spam", label: "Spam", color: "#eab308" },
  { key: "self-harm", label: "Self-Harm", color: "#8b5cf6" },
  { key: "sexual", label: "Sexual Content", color: "#ec4899" },
  { key: "violence", label: "Violence", color: "#dc2626" },
  { key: "hate/threatening", label: "Hate/Threatening", color: "#b91c1c" },
  { key: "harassment/threatening", label: "Harassment/Threatening", color: "#c2410c" },
  { key: "self-harm/intent", label: "Self-Harm Intent", color: "#7c3aed" },
  { key: "self-harm/instructions", label: "Self-Harm Instructions", color: "#6d28d9" },
  { key: "sexual/minors", label: "Sexual/Minors", color: "#be185d" },
  { key: "violence/graphic", label: "Violence/Graphic", color: "#991b1b" },
];
