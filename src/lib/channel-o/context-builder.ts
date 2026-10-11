import { db } from '../db.js'

const TYPE_PATTERNS: Record<string, string> = {
  shipped:   'Execution pattern: you ship what you start.',
  closed:    'Closing pattern: you commit and close.',
  raised:    'Fundraising execution: you have raised rounds before.',
  hired:     'Team-building: you consistently land the people you go after.',
  completed: 'Completion rate: you finish what you start.',
}

export function buildChannelOContextBlock(userId: string): string | null {
  const profile = db.prepare(`SELECT * FROM channel_o_profiles WHERE user_id = ?`).get(userId) as any
  if (!profile) return null
  if ((profile.total_achievements ?? 0) < 3) return null

  const lines: string[] = ['[Channel O — Achievement Record]']

  // Recent achievements (last 5)
  const recent = db.prepare(`
    SELECT achievement_type, achievement_text, created_at
    FROM channel_o_achievements WHERE user_id = ?
    ORDER BY rowid DESC LIMIT 5
  `).all(userId) as any[]

  const achievementSummary = recent
    .map((r: any) => `${r.achievement_text.slice(0, 80)}`)
    .slice(0, 3)
    .join('; ')

  lines.push(`${profile.total_achievements} milestones on record: ${achievementSummary}.`)

  // Dominant type pattern instruction
  if (profile.dominant_achievement_type && TYPE_PATTERNS[profile.dominant_achievement_type]) {
    lines.push(TYPE_PATTERNS[profile.dominant_achievement_type])
  }

  // Recent win (< 30 days) — confidence anchor
  if (profile.most_recent_achievement && profile.most_recent_at) {
    const daysSince = db.prepare(`
      SELECT CAST(julianday('now') - julianday(?) AS INTEGER) as days
    `).get(profile.most_recent_at) as { days: number }

    if ((daysSince?.days ?? 999) <= 30) {
      lines.push(`Recent win: "${profile.most_recent_achievement.slice(0, 100)}". Momentum is real.`)
    }
  }

  // Confidence anchor if user is in low confidence state (check channel-k)
  const cognitiveProfile = db.prepare(`SELECT confidence_level FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any
  if (cognitiveProfile?.confidence_level === 'low' && profile.most_recent_achievement) {
    lines.push(`Confidence note: you have done harder things than this. That track record is real.`)
  }

  if (lines.length === 1) return null
  return lines.join('\n')
}
