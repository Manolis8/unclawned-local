import { db } from '../db.js'

export interface StressCompositeResult {
  score: number
  confirmedBy: string[]
  level: 'high' | 'moderate'
}

// Each dimension is one binary vote. 4+ of 7 = composite stress state.
export function checkStressComposite(userId: string): StressCompositeResult | null {
  const confirmed: string[] = []

  // 1. Channel K: 2+ overload signals in last 24h
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM channel_k_signals
      WHERE user_id = ? AND signal_type = 'overload'
      AND created_at >= datetime('now', '-1 day')
    `).get(userId) as any
    if ((row?.cnt ?? 0) >= 2) confirmed.push('K-overload')
  } catch {}

  // 2. Channel K: energy state is depleted or low
  try {
    const row = db.prepare(`SELECT energy_state FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any
    if (row?.energy_state === 'depleted' || row?.energy_state === 'low') confirmed.push('K-energy')
  } catch {}

  // 3. Channel A: 2+ messages with frustration detected in last 24h
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM channel_a_raw_signals
      WHERE user_id = ? AND frustration_detected = 1
      AND created_at >= datetime('now', '-1 day')
    `).get(userId) as any
    if ((row?.cnt ?? 0) >= 2) confirmed.push('A')
  } catch {}

  // 4. Channel G: 2+ late-night tasks in last 3 days
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM channel_g_task_snapshots
      WHERE user_id = ? AND is_late_night = 1
      AND created_at >= datetime('now', '-3 days')
    `).get(userId) as any
    if ((row?.cnt ?? 0) >= 2) confirmed.push('G-night')
  } catch {}

  // 5. Channel G: 3+ urgency tasks in last 3 days
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM channel_g_task_snapshots
      WHERE user_id = ? AND has_urgency = 1
      AND created_at >= datetime('now', '-3 days')
    `).get(userId) as any
    if ((row?.cnt ?? 0) >= 3) confirmed.push('G-urgency')
  } catch {}

  // 6. Channel B: 2+ high corrections (level >= 3) in last 5 interactions
  try {
    const rows = db.prepare(`
      SELECT correction_level FROM channel_b_raw_signals
      WHERE user_id = ? AND is_correction = 1
      ORDER BY created_at DESC LIMIT 5
    `).all(userId) as any[]
    if (rows.filter(r => (r.correction_level ?? 0) >= 3).length >= 2) confirmed.push('B')
  } catch {}

  // 7. Channel L: 2+ avoidance signals in last 24h
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM channel_l_signals
      WHERE user_id = ? AND signal_type = 'avoidance'
      AND created_at >= datetime('now', '-1 day')
    `).get(userId) as any
    if ((row?.cnt ?? 0) >= 2) confirmed.push('L')
  } catch {}

  if (confirmed.length < 4) return null

  return {
    score: confirmed.length,
    confirmedBy: confirmed,
    level: confirmed.length >= 5 ? 'high' : 'moderate',
  }
}
