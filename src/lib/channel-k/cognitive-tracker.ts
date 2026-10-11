import { db, uuid, j } from '../db.js'
import {
  detectOverloadSignals, classifyEnergy, detectConfidenceSignal, isAssumptionLaden,
  type EnergyState,
} from './cognitive-classifier.js'

// ─── Profile update ───────────────────────────────────────────────────────────

function updateProfile(
  userId: string,
  messageLength: number,
  energyState: EnergyState,
  confidenceSignal: string | null,
): void {
  const existing = db.prepare(`SELECT * FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any

  const prevTotal: number = existing?.total_messages ?? 0
  const prevAvg: number = existing?.avg_message_length ?? 0
  const newTotal = prevTotal + 1
  // Rolling average with decay (last 20 messages dominate)
  const newAvg = prevTotal === 0 ? messageLength : (prevAvg * Math.min(prevTotal, 20) + messageLength) / (Math.min(prevTotal, 20) + 1)

  // Confidence level: look at recent low_confidence signals in last 24h
  const recentLowConfidence = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_k_signals
    WHERE user_id = ? AND signal_type = 'confidence' AND value = 'low_confidence'
    AND created_at >= datetime('now', '-24 hours')
  `).get(userId) as any)?.cnt ?? 0

  const confidenceLevel = recentLowConfidence >= 2 ? 'low' : recentLowConfidence === 1 ? 'uncertain' : 'normal'

  if (existing) {
    db.prepare(`
      UPDATE channel_k_profiles SET
        total_messages = ?, avg_message_length = ?,
        energy_state = ?, confidence_level = ?,
        last_updated = datetime('now')
      WHERE user_id = ?
    `).run(newTotal, newAvg, energyState, confidenceLevel, userId)
  } else {
    db.prepare(`
      INSERT INTO channel_k_profiles (user_id, total_messages, avg_message_length, energy_state, confidence_level)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, newTotal, newAvg, energyState, confidenceLevel)
  }
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export function trackCognitiveSignal(userId: string, sessionId: string, message: string): void {
  try {
    const profile = db.prepare(`SELECT avg_message_length, total_messages FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any
    const avgLength: number = profile?.avg_message_length ?? 0
    const totalMessages: number = profile?.total_messages ?? 0

    // Fetch recent message previews for duplicate detection (same session, last 30 min)
    const recentRows = db.prepare(`
      SELECT message_preview FROM channel_k_signals
      WHERE user_id = ? AND session_id = ?
      AND created_at >= datetime('now', '-30 minutes')
      ORDER BY created_at DESC LIMIT 5
    `).all(userId, sessionId) as any[]
    const recentPreviews = recentRows.map((r: any) => r.message_preview ?? '')

    // K.1 — overload signals (only meaningful once we have a baseline)
    const overloadSignals = totalMessages >= 5
      ? detectOverloadSignals(message, avgLength, recentPreviews)
      : detectOverloadSignals(message, 0, recentPreviews) // no baseline yet, skip short_vs_baseline

    for (const signal of overloadSignals) {
      db.prepare(`
        INSERT INTO channel_k_signals (id, user_id, session_id, signal_type, value, message_length, message_preview, created_at)
        VALUES (?, ?, ?, 'overload', ?, ?, ?, datetime('now'))
      `).run(uuid(), userId, sessionId, signal, message.length, message.slice(0, 120))
    }

    // K.2 — energy state
    const hour = new Date().getHours()
    const energyState = classifyEnergy(message, hour)
    db.prepare(`
      INSERT INTO channel_k_signals (id, user_id, session_id, signal_type, value, message_length, message_preview, created_at)
      VALUES (?, ?, ?, 'energy', ?, ?, ?, datetime('now'))
    `).run(uuid(), userId, sessionId, energyState, message.length, message.slice(0, 120))

    // K.3 — confidence signal
    const confSignal = detectConfidenceSignal(message)
    if (confSignal) {
      db.prepare(`
        INSERT INTO channel_k_signals (id, user_id, session_id, signal_type, value, message_length, message_preview, created_at)
        VALUES (?, ?, ?, 'confidence', ?, ?, ?, datetime('now'))
      `).run(uuid(), userId, sessionId, confSignal, message.length, message.slice(0, 120))
    }

    // K.4 — assumption-laden prompt
    if (isAssumptionLaden(message)) {
      db.prepare(`
        INSERT INTO channel_k_signals (id, user_id, session_id, signal_type, value, message_length, message_preview, created_at)
        VALUES (?, ?, ?, 'assumption', ?, ?, ?, datetime('now'))
      `).run(uuid(), userId, sessionId, 'assumption_detected', message.length, message.slice(0, 120))
    }

    updateProfile(userId, message.length, energyState, confSignal)
  } catch (err) {
    console.error('[channel-k] track error:', err)
  }
}
