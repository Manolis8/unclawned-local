import { db, uuid } from '../../db.js'

export interface Authorization {
  id: string
  user_id: string
  category: string
  auth_level: number
  scope_params: any
  authorized_at: string
  expires_at: string | null
  last_executed_at: string | null
  reversal_count: number
  status: string
}

const EXPIRY_DAYS = 90
const DE_ESCALATE_AT_REVERSALS = 3

const CATEGORY_CADENCE_DAYS: Record<string, number> = {
  session_prep: 1,
  relationship_touchpoints: 7,
}

export function getAuthorization(userId: string, category: string): Authorization | null {
  try {
    const row = db.prepare(`
      SELECT * FROM autonomous_authorizations
      WHERE user_id = ? AND category = ? AND status = 'active'
        AND (expires_at IS NULL OR datetime('now') < expires_at)
    `).get(userId, category) as any
    if (!row) return null
    row.scope_params = row.scope_params ? JSON.parse(row.scope_params) : {}
    return row as Authorization
  } catch { return null }
}

export function listAuthorizations(userId: string): Authorization[] {
  try {
    const rows = db.prepare(`
      SELECT * FROM autonomous_authorizations WHERE user_id = ? ORDER BY authorized_at DESC
    `).all(userId) as any[]
    return rows.map(r => ({ ...r, scope_params: r.scope_params ? JSON.parse(r.scope_params) : {} }))
  } catch { return [] }
}

export function createAuthorization(
  userId: string,
  category: string,
  level: 2 | 3 = 2,
  scopeParams: Record<string, unknown> = {}
): void {
  try {
    const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 86400000)
      .toISOString().replace('T', ' ').slice(0, 19)
    db.prepare(`
      INSERT INTO autonomous_authorizations
        (id, user_id, category, auth_level, scope_params, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, category) DO UPDATE SET
        auth_level = excluded.auth_level,
        scope_params = excluded.scope_params,
        authorized_at = datetime('now'),
        expires_at = excluded.expires_at,
        reversal_count = 0,
        status = 'active'
    `).run(uuid(), userId, category, level, JSON.stringify(scopeParams), expiresAt)
  } catch {}
}

export function revokeAuthorization(userId: string, category: string): void {
  try {
    db.prepare(`
      UPDATE autonomous_authorizations SET status = 'revoked' WHERE user_id = ? AND category = ?
    `).run(userId, category)
  } catch {}
}

// Called when user cancels/reverses a prepared execution. 3 reversals → de-escalate level 2 to level 3.
export function recordReversal(userId: string, category: string): void {
  try {
    db.prepare(`
      UPDATE autonomous_authorizations
      SET reversal_count = reversal_count + 1
      WHERE user_id = ? AND category = ?
    `).run(userId, category)

    const row = db.prepare(`
      SELECT reversal_count, auth_level FROM autonomous_authorizations
      WHERE user_id = ? AND category = ?
    `).get(userId, category) as any

    if (row && row.reversal_count >= DE_ESCALATE_AT_REVERSALS && row.auth_level === 2) {
      db.prepare(`
        UPDATE autonomous_authorizations SET auth_level = 3 WHERE user_id = ? AND category = ?
      `).run(userId, category)
    }
  } catch {}
}

export function markExecuted(userId: string, category: string): void {
  try {
    db.prepare(`
      UPDATE autonomous_authorizations
      SET last_executed_at = datetime('now')
      WHERE user_id = ? AND category = ?
    `).run(userId, category)
  } catch {}
}

// Returns categories that are authorized AND due for execution
export function getDueCategories(userId: string): string[] {
  try {
    const rows = db.prepare(`
      SELECT category, last_executed_at, auth_level
      FROM autonomous_authorizations
      WHERE user_id = ? AND status = 'active'
        AND (expires_at IS NULL OR datetime('now') < expires_at)
    `).all(userId) as any[]

    return rows
      .filter(r => {
        const cadence = CATEGORY_CADENCE_DAYS[r.category] ?? 1
        if (!r.last_executed_at) return true
        const daysSince = (Date.now() - new Date(r.last_executed_at).getTime()) / 86400000
        return daysSince >= cadence
      })
      .map(r => r.category)
  } catch { return [] }
}

export function expireStaleAuthorizations(userId: string): void {
  try {
    db.prepare(`
      UPDATE autonomous_authorizations
      SET status = 'expired'
      WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL
        AND datetime('now') >= expires_at
    `).run(userId)
  } catch {}
}
