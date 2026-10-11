import { db, uuid, j, p } from '../db.js'
import {
  classifyUrlSource, classifyTextSource, extractUrls,
  classifyDepthPreference, classifyTaskMode, isInfoAnxiety,
  type SourceType,
} from './source-classifier.js'

// ─── Record helpers ────────────────────────────────────────────────────────────

function record(userId: string, sessionId: string, signalType: string, extra: Record<string, string | null>): void {
  db.prepare(`
    INSERT INTO channel_j_signals (id, user_id, session_id, signal_type, value, message_preview, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(uuid(), userId, sessionId, signalType, extra.value ?? null, extra.preview ?? null)
}

// ─── Profile update ────────────────────────────────────────────────────────────

function updateProfile(userId: string): void {
  // J.1 — source type counts + dominant
  const sourceRows = db.prepare(`
    SELECT value AS src, COUNT(*) AS cnt FROM channel_j_signals
    WHERE user_id = ? AND signal_type = 'source'
    GROUP BY value
  `).all(userId) as any[]

  const sourceCounts: Record<string, number> = {}
  for (const r of sourceRows) sourceCounts[r.src] = r.cnt
  const dominantSource = sourceRows.sort((a, b) => b.cnt - a.cnt)[0]?.src ?? null

  // J.2 — depth preference (majority of explicit signals)
  const depthRows = db.prepare(`
    SELECT value, COUNT(*) AS cnt FROM channel_j_signals
    WHERE user_id = ? AND signal_type = 'depth'
    GROUP BY value
  `).all(userId) as any[]

  const depthCounts: Record<string, number> = {}
  for (const r of depthRows) depthCounts[r.value] = r.cnt

  let depthPreference = 'unknown'
  const highCnt = depthCounts['high'] ?? 0
  const lowCnt = depthCounts['low'] ?? 0
  if (highCnt > 0 || lowCnt > 0) {
    const ratio = highCnt / (highCnt + lowCnt)
    if (ratio >= 0.65) depthPreference = 'high'
    else if (ratio <= 0.35) depthPreference = 'low'
    else depthPreference = 'medium'
  }

  // J.3 — consumption/production ratio
  const modeRows = db.prepare(`
    SELECT value, COUNT(*) AS cnt FROM channel_j_signals
    WHERE user_id = ? AND signal_type = 'task_mode'
    GROUP BY value
  `).all(userId) as any[]

  const modeCounts: Record<string, number> = {}
  for (const r of modeRows) modeCounts[r.value] = r.cnt
  const totalMode = (modeCounts['consumption'] ?? 0) + (modeCounts['production'] ?? 0)
  const consumptionRatio = totalMode > 0 ? (modeCounts['consumption'] ?? 0) / totalMode : 0.5

  // J.4 — info anxiety count
  const anxietyCount = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_j_signals
    WHERE user_id = ? AND signal_type = 'info_anxiety'
  `).get(userId) as any)?.cnt ?? 0

  const totalSignals = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_j_signals WHERE user_id = ?
  `).get(userId) as any)?.cnt ?? 0

  const existing = db.prepare(`SELECT user_id FROM channel_j_profiles WHERE user_id = ?`).get(userId)
  if (existing) {
    db.prepare(`
      UPDATE channel_j_profiles SET
        source_counts = ?, dominant_source_type = ?,
        depth_preference = ?,
        consumption_ratio = ?,
        info_anxiety_count = ?,
        total_signals = ?,
        last_updated = datetime('now')
      WHERE user_id = ?
    `).run(j(sourceCounts), dominantSource, depthPreference, consumptionRatio, anxietyCount, totalSignals, userId)
  } else {
    db.prepare(`
      INSERT INTO channel_j_profiles
        (user_id, source_counts, dominant_source_type, depth_preference, consumption_ratio, info_anxiety_count, total_signals)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, j(sourceCounts), dominantSource, depthPreference, consumptionRatio, anxietyCount, totalSignals)
  }
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export function trackInfoDiet(userId: string, sessionId: string, message: string): void {
  try {
    let recorded = false

    // J.1 — source detection: URLs first, then text patterns
    const urls = extractUrls(message)
    for (const url of urls) {
      const srcType = classifyUrlSource(url)
      if (srcType) {
        record(userId, sessionId, 'source', { value: srcType, preview: message.slice(0, 120) })
        recorded = true
      }
    }
    // Also check text patterns (catches references without URLs)
    const textSrc = classifyTextSource(message)
    if (textSrc && urls.length === 0) {
      record(userId, sessionId, 'source', { value: textSrc, preview: message.slice(0, 120) })
      recorded = true
    }

    // J.2 — depth preference
    const depth = classifyDepthPreference(message)
    if (depth) {
      record(userId, sessionId, 'depth', { value: depth, preview: message.slice(0, 120) })
      recorded = true
    }

    // J.3 — task mode
    const mode = classifyTaskMode(message)
    if (mode) {
      record(userId, sessionId, 'task_mode', { value: mode, preview: message.slice(0, 120) })
      recorded = true
    }

    // J.4 — info anxiety
    if (isInfoAnxiety(message)) {
      record(userId, sessionId, 'info_anxiety', { value: null, preview: message.slice(0, 120) })
      recorded = true
    }

    if (recorded) updateProfile(userId)
  } catch (err) {
    console.error('[channel-j] track error:', err)
  }
}
