export type ActionTier = 0 | 1 | 2 | 3 | 4

const TIER_MAP: [RegExp, ActionTier][] = [
  // Tier 0 — read / navigate / local read — no side effects
  [/^(navigate|scroll|read|search|perceive|snapshot|extract|visit|open|browse|view|check|look|find|list|get|fetch|load|detect|scan|read_file|list_directory|find_file|read_clipboard)$/i, 0],
  // Tier 1 — fill / type without submitting — reversible
  [/^(fill|type|input|enter|draft|add_to_cart|write)$/i, 1],
  // Tier 2 — low-stakes social actions — single yes/no
  [/^(follow|unfollow|like|unlike|bookmark|subscribe|save_draft|connect|react|upvote|downvote|pin|star|favourite|fav|heart|endorse)$/i, 2],
  // Tier 3 — content publishing / sending — preview-then-confirm
  [/^(post|comment|reply|send_message|send_dm|send_email|publish|upload|share|tweet|retweet|forward|create_post|write_post|post_update|message|email|send)$/i, 3],
  // Tier 3 — form submissions with real-world effects
  [/^(submit|apply|purchase|buy|checkout|order|place_order|book|register|confirm_order|pay)$/i, 3],
  // Tier 2 — open app (low stakes, single confirm)
  [/^(open_app|write_clipboard)$/i, 2],
  // Tier 3 — local write / command with side effects
  [/^(write_file|append_file|run_command|run_script)$/i, 3],
  // Tier 4 — destructive — cannot be undone
  [/^(delete|remove|unsubscribe|cancel_subscription|cancel_account|revoke|clear|wipe|archive|close_account|deactivate|destroy|erase|purge|delete_file|overwrite_file|run_destructive_command)$/i, 4],
]

export function getActionTier(action_type: string): ActionTier {
  const normalised = action_type.toLowerCase().trim().replace(/[\s\-]+/g, '_')
  for (const [pattern, tier] of TIER_MAP) {
    if (pattern.test(normalised)) return tier
  }
  // Unknown action → default to T2 (single confirm) — safer than letting it through silently
  return 2
}
