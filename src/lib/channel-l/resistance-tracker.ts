import { db } from '../db.js'
import { classifyResistance, classifyAvoidance, detectKeptWork, extractDomain } from './resistance-classifier.js'

function uuid(): string {
  return (globalThis as any).crypto?.randomUUID?.() ?? require('crypto').randomUUID()
}

function p(s: string) { try { return JSON.parse(s) } catch { return null } }
function j(v: unknown) { return JSON.stringify(v) }

export function trackResistanceSignal(userId: string, sessionId: string, message: string): void {
  const resistanceType = classifyResistance(message)
  const avoidanceType = classifyAvoidance(message)
  const keptWork = detectKeptWork(message)
  const domain = extractDomain(message)
  const preview = message.slice(0, 120)

  if (!resistanceType && !avoidanceType && !keptWork) return

  const insertSignal = db.prepare(`
    INSERT INTO channel_l_signals (id, user_id, session_id, signal_type, subtype, domain, message_preview)
    VALUES (randomblob(16), ?, ?, ?, ?, ?, ?)
  `)

  if (resistanceType) {
    insertSignal.run(userId, sessionId, 'resistance', resistanceType, domain, preview)
  }
  if (avoidanceType) {
    insertSignal.run(userId, sessionId, 'avoidance', avoidanceType, domain, preview)
  }
  if (keptWork) {
    insertSignal.run(userId, sessionId, 'kept_work', domain ?? 'unknown', domain, preview)
  }

  _updateProfile(userId)
}

function _updateProfile(userId: string): void {
  const existing = db.prepare(`SELECT * FROM channel_l_profiles WHERE user_id = ?`).get(userId) as any

  // Count resistance by type
  const resistanceCounts = db.prepare(`
    SELECT subtype, COUNT(*) as cnt
    FROM channel_l_signals WHERE user_id = ? AND signal_type = 'resistance'
    GROUP BY subtype
  `).all(userId) as { subtype: string; cnt: number }[]

  const rc: Record<string, number> = {}
  for (const row of resistanceCounts) rc[row.subtype] = row.cnt

  const factual = rc['factual'] ?? 0
  const framing = rc['framing'] ?? 0
  const scope = rc['scope'] ?? 0
  const strategic = rc['strategic'] ?? 0
  const totalResistance = factual + framing + scope + strategic

  const dominant = totalResistance === 0 ? null
    : Object.entries({ factual, framing, scope, strategic })
        .sort(([, a], [, b]) => b - a)[0][0]

  // Blind spot domains: domains with 3+ strategic resistance signals
  const strategicByDomain = db.prepare(`
    SELECT domain, COUNT(*) as cnt
    FROM channel_l_signals WHERE user_id = ? AND signal_type = 'resistance' AND subtype = 'strategic' AND domain IS NOT NULL
    GROUP BY domain
  `).all(userId) as { domain: string; cnt: number }[]

  const blindSpotDomains = strategicByDomain.filter(r => r.cnt >= 3).map(r => r.domain)

  // Count avoidance by type
  const avoidanceCounts = db.prepare(`
    SELECT subtype, COUNT(*) as cnt
    FROM channel_l_signals WHERE user_id = ? AND signal_type = 'avoidance'
    GROUP BY subtype
  `).all(userId) as { subtype: string; cnt: number }[]

  const av: Record<string, number> = {}
  for (const row of avoidanceCounts) av[row.subtype] = row.cnt

  // Kept work categories
  const keptWorkRows = db.prepare(`
    SELECT subtype, COUNT(*) as cnt
    FROM channel_l_signals WHERE user_id = ? AND signal_type = 'kept_work'
    GROUP BY subtype
  `).all(userId) as { subtype: string; cnt: number }[]

  const keptWorkCategories: string[] = keptWorkRows.filter(r => r.cnt >= 2).map(r => r.subtype)

  const totalSignals = db.prepare(`
    SELECT COUNT(*) as cnt FROM channel_l_signals WHERE user_id = ?
  `).get(userId) as { cnt: number }

  const prevOfferMade = p(existing?.kept_work_offer_made ?? '{}') ?? {}

  if (existing) {
    db.prepare(`
      UPDATE channel_l_profiles SET
        total_signals = ?,
        factual_resistance_count = ?,
        framing_resistance_count = ?,
        scope_resistance_count = ?,
        strategic_resistance_count = ?,
        dominant_resistance = ?,
        blind_spot_domains = ?,
        capability_avoidance_count = ?,
        skill_avoidance_count = ?,
        priority_avoidance_count = ?,
        emotional_avoidance_count = ?,
        identity_avoidance_count = ?,
        kept_work_categories = ?,
        updated_at = datetime('now')
      WHERE user_id = ?
    `).run(
      totalSignals.cnt,
      factual, framing, scope, strategic,
      dominant,
      j(blindSpotDomains),
      av['capability'] ?? 0,
      av['skill'] ?? 0,
      av['priority'] ?? 0,
      av['emotional'] ?? 0,
      av['identity'] ?? 0,
      j(keptWorkCategories),
      userId
    )
  } else {
    db.prepare(`
      INSERT INTO channel_l_profiles (
        user_id, total_signals,
        factual_resistance_count, framing_resistance_count, scope_resistance_count, strategic_resistance_count,
        dominant_resistance, blind_spot_domains,
        capability_avoidance_count, skill_avoidance_count, priority_avoidance_count,
        emotional_avoidance_count, identity_avoidance_count,
        kept_work_categories, kept_work_offer_made
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
    `).run(
      userId, totalSignals.cnt,
      factual, framing, scope, strategic,
      dominant,
      j(blindSpotDomains),
      av['capability'] ?? 0,
      av['skill'] ?? 0,
      av['priority'] ?? 0,
      av['emotional'] ?? 0,
      av['identity'] ?? 0,
      j(keptWorkCategories)
    )
  }
}
