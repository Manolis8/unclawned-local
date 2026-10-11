import { db, uuid } from '../db.js'

export interface OpenItem {
  id: string
  user_id: string
  item_type: string
  summary: string
  context: string | null
  related_person: string | null
  opened_at: string
  status: string
  resolved_at: string | null
  follow_up_after_days: number
  last_surfaced_at: string | null
}

export function addOpenItem(
  userId: string,
  itemType: string,
  summary: string,
  context: string | null = null,
  relatedPerson: string | null = null,
  followUpAfterDays = 3
): void {
  try {
    db.prepare(`
      INSERT INTO open_items (id, user_id, item_type, summary, context, related_person, follow_up_after_days)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), userId, itemType, summary, context, relatedPerson, followUpAfterDays)
  } catch {}
}

export function getOpenItems(userId: string): OpenItem[] {
  try {
    return db.prepare(`
      SELECT * FROM open_items WHERE user_id = ? AND status = 'open'
      ORDER BY opened_at DESC
    `).all(userId) as OpenItem[]
  } catch { return [] }
}

export function getOverdueOpenItems(userId: string): OpenItem[] {
  try {
    return db.prepare(`
      SELECT * FROM open_items
      WHERE user_id = ?
        AND status = 'open'
        AND julianday('now') - julianday(opened_at) >= follow_up_after_days
      ORDER BY opened_at ASC
    `).all(userId) as OpenItem[]
  } catch { return [] }
}

export function resolveItem(id: string): void {
  try {
    db.prepare(`
      UPDATE open_items SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?
    `).run(id)
  } catch {}
}

export function dismissItem(id: string): void {
  try {
    db.prepare(`UPDATE open_items SET status = 'dismissed' WHERE id = ?`).run(id)
  } catch {}
}

export function resolveByKeyword(userId: string, keyword: string): number {
  try {
    const result = db.prepare(`
      UPDATE open_items
      SET status = 'resolved', resolved_at = datetime('now')
      WHERE user_id = ? AND status = 'open' AND lower(summary) LIKE lower(?)
    `).run(userId, `%${keyword}%`)
    return result.changes
  } catch { return 0 }
}

export function markStaleOldItems(userId: string): void {
  try {
    // Items older than 30 days with no resolution become stale
    db.prepare(`
      UPDATE open_items SET status = 'stale'
      WHERE user_id = ? AND status = 'open'
        AND julianday('now') - julianday(opened_at) > 30
    `).run(userId)
  } catch {}
}

export function markSurfaced(id: string): void {
  try {
    db.prepare(`UPDATE open_items SET last_surfaced_at = datetime('now') WHERE id = ?`).run(id)
  } catch {}
}

export function getTopOverdueItem(userId: string): OpenItem | null {
  try {
    return db.prepare(`
      SELECT * FROM open_items
      WHERE user_id = ?
        AND status = 'open'
        AND julianday('now') - julianday(opened_at) >= follow_up_after_days
      ORDER BY opened_at ASC
      LIMIT 1
    `).get(userId) as OpenItem | null
  } catch { return null }
}

export function daysSince(isoDate: string): number {
  const opened = new Date(isoDate).getTime()
  return Math.floor((Date.now() - opened) / (1000 * 60 * 60 * 24))
}
