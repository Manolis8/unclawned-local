import { db, uuid } from '../../db.js'
import {
  getDueCategories, getAuthorization, markExecuted, expireStaleAuthorizations, recordReversal
} from './authorization.js'
import { prepareSessionBriefing } from './session-prep.js'
import { prepareRelationshipTouchpoint } from './relationship-touchpoint.js'

export interface PreparedExecution {
  id: string
  category: string
  title: string
  content: string
  auth_level: number
  authorization_id: string
}

// Run all due Level 2 autonomous executions for this user, store results.
// Returns executions that are ready to surface (Level 2 executes automatically;
// Level 3 items are also prepared here but surfaced as pending-confirmation).
export function runDueExecutions(userId: string): PreparedExecution[] {
  try {
    expireStaleAuthorizations(userId)

    // Carry-overs: prepared in a prior session but never surfaced, still within expiry window.
    // These go first so crowded-out items get a turn before new ones are prepared.
    const carryOvers = db.prepare(`
      SELECT ae.id, ae.category, ae.title, ae.content, ae.authorization_id, aa.auth_level
      FROM autonomous_executions ae
      JOIN autonomous_authorizations aa ON ae.authorization_id = aa.id
      WHERE ae.user_id = ? AND ae.status = 'prepared' AND ae.surfaced_at IS NULL
        AND (ae.expires_at IS NULL OR datetime('now') < ae.expires_at)
      ORDER BY ae.created_at ASC
    `).all(userId) as PreparedExecution[]

    // Skip re-preparation for categories that already have a carry-over
    const alreadyPrepared = new Set(carryOvers.map(r => r.category))

    const due = getDueCategories(userId).filter(cat => !alreadyPrepared.has(cat))

    const results: PreparedExecution[] = [...carryOvers]

    for (const category of due) {
      const auth = getAuthorization(userId, category)
      if (!auth) continue

      let prepared: { title: string; content: string } | null = null

      if (category === 'session_prep') {
        prepared = prepareSessionBriefing(userId)
      } else if (category === 'relationship_touchpoints') {
        prepared = prepareRelationshipTouchpoint(userId, auth.scope_params)
      }

      if (!prepared) continue

      const expiresAt = new Date(Date.now() + 48 * 3600000)
        .toISOString().replace('T', ' ').slice(0, 19)

      const id = uuid()
      db.prepare(`
        INSERT INTO autonomous_executions
          (id, user_id, category, authorization_id, title, content, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, category, auth.id, prepared.title, prepared.content, expiresAt)

      markExecuted(userId, category)

      results.push({
        id,
        category,
        title: prepared.title,
        content: prepared.content,
        auth_level: auth.auth_level,
        authorization_id: auth.id
      })
    }

    return results
  } catch { return [] }
}

// Get prepared executions that haven't been surfaced yet
export function getPreparedExecutions(userId: string): PreparedExecution[] {
  try {
    const rows = db.prepare(`
      SELECT ae.id, ae.category, ae.title, ae.content, aa.auth_level, ae.authorization_id
      FROM autonomous_executions ae
      JOIN autonomous_authorizations aa ON ae.authorization_id = aa.id
      WHERE ae.user_id = ? AND ae.status = 'prepared'
        AND (ae.expires_at IS NULL OR datetime('now') < ae.expires_at)
      ORDER BY ae.created_at ASC
    `).all(userId) as any[]
    return rows as PreparedExecution[]
  } catch { return [] }
}

export function markExecutionSurfaced(id: string): void {
  try {
    db.prepare(`
      UPDATE autonomous_executions SET status = 'surfaced', surfaced_at = datetime('now') WHERE id = ?
    `).run(id)
  } catch {}
}

export function markExecutionConfirmed(id: string): void {
  try {
    db.prepare(`UPDATE autonomous_executions SET status = 'confirmed' WHERE id = ?`).run(id)
  } catch {}
}

export function markExecutionCancelled(id: string, userId: string, category: string): void {
  try {
    db.prepare(`UPDATE autonomous_executions SET status = 'cancelled' WHERE id = ?`).run(id)
    recordReversal(userId, category)
  } catch {}
}
