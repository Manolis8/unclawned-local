import { db } from '../db.js'

const SURFACE_THRESHOLD = 50
const SESSION_GAP_HOURS = 2
const MAX_EVENTS_PER_SESSION = 2

export function buildChannelNContextBlock(userId: string): string | null {
  // Only surface at session start: enforce a gap since last surface
  const profile = db.prepare(`SELECT * FROM channel_n_profiles WHERE user_id = ?`).get(userId) as any
  if (profile?.last_surfaced_at) {
    const hoursSince = db.prepare(`
      SELECT CAST((julianday('now') - julianday(?)) * 24 AS INTEGER) as hrs
    `).get(profile.last_surfaced_at) as { hrs: number }
    if ((hoursSince?.hrs ?? 0) < SESSION_GAP_HOURS) return null
  }

  // Don't surface if user is in depleted energy state (check channel-k profile)
  const cognitiveProfile = db.prepare(`SELECT energy_state FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any
  if (cognitiveProfile?.energy_state === 'depleted') return null

  // Fetch top unsurfaced events above relevance threshold, ranked by score
  const events = db.prepare(`
    SELECT id, entity_name, event_type, headline, relevance_score
    FROM channel_n_events
    WHERE user_id = ? AND surfaced = 0 AND relevance_score >= ?
    ORDER BY relevance_score DESC
    LIMIT ?
  `).all(userId, SURFACE_THRESHOLD, MAX_EVENTS_PER_SESSION) as any[]

  if (events.length === 0) return null

  const lines: string[] = ['[Channel N — World Intelligence]']
  lines.push('Before we begin — a few things from your world that may be relevant:')

  for (const ev of events) {
    const typeLabel: Record<string, string> = {
      funding: '[Funding]', launch: '[Launch]', personnel: '[People]', news: '[News]',
    }
    const label = typeLabel[ev.event_type] ?? '[Update]'
    lines.push(`${label} ${ev.headline}`)
  }

  // Mark these events as surfaced + update last_surfaced_at
  const ids = events.map((e: any) => e.id)
  for (const id of ids) {
    db.prepare(`UPDATE channel_n_events SET surfaced = 1 WHERE id = ?`).run(id)
  }

  if (profile) {
    db.prepare(`UPDATE channel_n_profiles SET last_surfaced_at = datetime('now') WHERE user_id = ?`).run(userId)
  } else {
    db.prepare(`INSERT INTO channel_n_profiles (user_id, last_surfaced_at) VALUES (?, datetime('now'))`).run(userId)
  }

  return lines.join('\n')
}
