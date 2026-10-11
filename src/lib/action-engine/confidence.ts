import { db } from '../db.js'

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'cold'

export interface ModelConfidence {
  overall: number        // 0-100
  level: ConfidenceLevel
  session_count: number
  channels_active: number
}

const CHANNEL_TABLES = [
  'channel_a_profiles', 'channel_b_profiles', 'channel_c_profiles', 'channel_d_profiles',
  'channel_e_profiles', 'channel_f_relationship_profiles', 'channel_g_task_snapshots',
  'channel_h_profiles', 'channel_l_profiles', 'channel_m_profiles',
]

export function getModelConfidence(userId: string): ModelConfidence {
  try {
    const sessionCount = (db.prepare(`SELECT COUNT(*) as c FROM agent_sessions WHERE user_id = ?`).get(userId) as any)?.c ?? 0

    // Count channels that have meaningful data for this user
    let channelsActive = 0
    for (const table of CHANNEL_TABLES) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ?`).get(userId) as any
        if ((row?.c ?? 0) > 0) channelsActive++
      } catch {}
    }

    // Session volume score (0-40)
    let score = 0
    if (sessionCount >= 50) score += 40
    else if (sessionCount >= 20) score += 28
    else if (sessionCount >= 10) score += 18
    else if (sessionCount >= 5) score += 10

    // Channel coverage score (0-30): up to 10 active channels
    score += Math.min(channelsActive, 10) * 3

    // Correction ratio from Channel B (0-20): low corrections = higher confidence
    try {
      const bProfile = db.prepare(`SELECT total_reactions FROM channel_b_profiles WHERE user_id = ?`).get(userId) as any
      const reactions = bProfile?.total_reactions ?? 0
      if (reactions >= 20) score += 20
      else if (reactions >= 10) score += 14
      else if (reactions >= 5) score += 8
    } catch {}

    // Profile completeness (0-10)
    try {
      const profileCount = (db.prepare(`SELECT COUNT(*) as c FROM user_profile WHERE user_id = ?`).get(userId) as any)?.c ?? 0
      score += Math.min(profileCount * 2, 10)
    } catch {}

    const level: ConfidenceLevel =
      score >= 75 ? 'high' :
      score >= 40 ? 'medium' :
      score >= 20 ? 'low' :
      'cold'

    return { overall: score, level, session_count: sessionCount, channels_active: channelsActive }
  } catch {
    return { overall: 0, level: 'cold', session_count: 0, channels_active: 0 }
  }
}

// Returns a context line to inject into the agent system prompt based on confidence level
export function buildConfidencePreamble(confidence: ModelConfidence): string | null {
  switch (confidence.level) {
    case 'cold':
      return `[Calibration status]\nStill in early calibration — only ${confidence.session_count} sessions observed. Apply general best practices rather than inferred patterns. Ask clarifying questions more often than usual.`
    case 'low':
      return `[Calibration status]\nLimited data (${confidence.session_count} sessions, ${confidence.channels_active} channels active). Going with reasonable defaults — flag uncertainty where relevant.`
    case 'medium':
      return `[Calibration status]\nModerate data available. Apply inferred patterns but signal uncertainty where relevant.`
    default:
      return null  // high confidence: no preamble needed
  }
}
