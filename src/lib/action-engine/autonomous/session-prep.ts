import { db } from '../../db.js'

export interface SessionBriefing {
  title: string
  content: string
}

export function prepareSessionBriefing(userId: string): SessionBriefing | null {
  try {
    const lines: string[] = []

    // Pending insights
    const queueCount = (db.prepare(`
      SELECT COUNT(*) as c FROM action_queue WHERE user_id = ? AND status = 'queued'
    `).get(userId) as any)?.c ?? 0
    if (queueCount > 0) {
      const cats = db.prepare(`
        SELECT action_category FROM action_queue WHERE user_id = ? AND status = 'queued' LIMIT 3
      `).all(userId) as any[]
      lines.push(`${queueCount} insight${queueCount > 1 ? 's' : ''} queued: ${cats.map(r => r.action_category).join(', ')}`)
    }

    // Open items overdue
    const overdueItems = db.prepare(`
      SELECT summary, related_person, opened_at FROM open_items
      WHERE user_id = ? AND status = 'open'
        AND julianday('now') - julianday(opened_at) >= follow_up_days
      ORDER BY opened_at ASC LIMIT 3
    `).all(userId) as any[]
    for (const item of overdueItems) {
      const days = Math.floor((Date.now() - new Date(item.opened_at).getTime()) / 86400000)
      const who = item.related_person ? ` (${item.related_person})` : ''
      lines.push(`Follow-up due: ${item.summary.toLowerCase()}${who} — ${days}d ago`)
    }

    // Most recent session
    const lastSession = db.prepare(`
      SELECT task_prompt, task_summary, outcome, created_at FROM agent_sessions
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(userId) as any
    if (lastSession) {
      const taskShort = lastSession.task_prompt.slice(0, 60)
      lines.push(`Last session: "${taskShort}" — ${lastSession.outcome}`)
    }

    if (!lines.length) return null

    return {
      title: 'Session Prep',
      content: lines.map(l => `  • ${l}`).join('\n')
    }
  } catch { return null }
}
