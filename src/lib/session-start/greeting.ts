import { getOverdueOpenItems, markSurfaced, daysSince } from '../open-items/tracker.js'
import { db } from '../db.js'

function markStaleOldItemsLocal(userId: string): void {
  try {
    db.prepare(`
      UPDATE open_items SET status = 'stale'
      WHERE user_id = ? AND status = 'open'
        AND julianday('now') - julianday(opened_at) > 30
    `).run(userId)
  } catch {}
}

function getRecentAchievement(userId: string): string | null {
  try {
    const row = db.prepare(`
      SELECT most_recent_achievement, most_recent_at FROM channel_o_profiles
      WHERE user_id = ?
    `).get(userId) as any
    if (!row?.most_recent_achievement) return null
    const daysAgo = daysSince(row.most_recent_at)
    if (daysAgo > 7) return null
    return row.most_recent_achievement
  } catch { return null }
}

function getDriftDirection(userId: string): string | null {
  try {
    const row = db.prepare(`SELECT drift_direction FROM channel_m_profiles WHERE user_id = ?`).get(userId) as any
    return row?.drift_direction ?? null
  } catch { return null }
}

export function generateSessionGreeting(userId: string): string | null {
  try {
    markStaleOldItemsLocal(userId)

    const overdue = getOverdueOpenItems(userId)
    const recentWin = getRecentAchievement(userId)
    const driftTopic = getDriftDirection(userId)

    const lines: string[] = []

    if (overdue.length > 0) {
      const top = overdue[0]
      const days = daysSince(top.opened_at)
      const daysLabel = days === 1 ? 'yesterday' : `${days} days ago`

      let line = `${top.summary.charAt(0).toUpperCase() + top.summary.slice(1)} — ${daysLabel}.`
      if (top.related_person) line += ` (${top.related_person})`
      lines.push(line)

      if (overdue.length > 1) {
        lines.push(`${overdue.length - 1} other open thread${overdue.length > 2 ? 's' : ''} also waiting.`)
      }

      lines.push(`Type /followups to see everything or mark things resolved.`)

      // Mark the top item as surfaced so we don't spam it every session
      markSurfaced(top.id)
    } else if (recentWin) {
      lines.push(`Last session: ${recentWin}`)
    } else if (driftTopic) {
      lines.push(`Looks like ${driftTopic} has been your main focus recently.`)
    }

    if (lines.length === 0) return null

    return lines.join(' ')
  } catch { return null }
}
