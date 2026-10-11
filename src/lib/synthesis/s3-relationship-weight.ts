import { db } from '../db.js'

export interface ImportantRelationship {
  name: string
  importanceScore: number
  trajectory: string
  daysSinceContact: number
  register: string | null
  isBridge: boolean
}

// Scores a person across multiple channels. Threshold 3+ to be considered high-importance.
export function getHighImportanceRelationships(userId: string): ImportantRelationship[] {
  let profiles: any[] = []
  try {
    profiles = db.prepare(`
      SELECT person_name, mention_count, trajectory, is_bridge,
             communication_register, last_seen
      FROM channel_f_relationship_profiles
      WHERE user_id = ? AND last_seen >= datetime('now', '-30 days')
      ORDER BY mention_count DESC
      LIMIT 20
    `).all(userId) as any[]
  } catch { return [] }

  const results: ImportantRelationship[] = []

  for (const p of profiles) {
    let score = 0

    // Mention frequency (Channel F)
    const mentions = p.mention_count ?? 0
    if (mentions >= 15) score += 3
    else if (mentions >= 7) score += 2
    else if (mentions >= 3) score += 1

    // Rising trajectory (Channel F)
    if (p.trajectory === 'rising') score += 1

    // Bridge node — spans multiple contexts (Channel F)
    if (p.is_bridge) score += 1

    // Also appears in world events watchlist (Channel N cross-read)
    try {
      const wl = db.prepare(`
        SELECT mentions_count FROM channel_n_watchlist
        WHERE user_id = ? AND entity_name = ?
      `).get(userId, p.person_name) as any
      if ((wl?.mentions_count ?? 0) >= 3) score += 1
    } catch {}

    // Communication register is mapped (reliable agent can use it)
    if (p.communication_register) score += 1

    if (score < 3) continue

    const msAgo = Date.now() - new Date(p.last_seen + 'Z').getTime()
    const daysSinceContact = Math.floor(msAgo / (1000 * 60 * 60 * 24))

    results.push({
      name: p.person_name,
      importanceScore: score,
      trajectory: p.trajectory ?? 'stable',
      daysSinceContact,
      register: p.communication_register ?? null,
      isBridge: !!p.is_bridge,
    })
  }

  return results
    .sort((a, b) => b.importanceScore - a.importanceScore)
    .slice(0, 3)
}
