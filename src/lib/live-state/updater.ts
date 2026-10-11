import { db } from '../db.js'

function deriveSessionIntent(userId: string, sessionId: string): string {
  try {
    const rows = db.prepare(`
      SELECT content FROM chat_messages
      WHERE user_id = ? AND chat_id = ? AND role = 'user'
      ORDER BY created_at DESC LIMIT 4
    `).all(userId, sessionId) as any[]

    const combined = rows.map((r: any) => (r.content || '').toLowerCase()).join(' ')
    if (/\b(wrong|broken|fix|error|not working|failed|redo|try again|that'?s not|incorrect|still wrong)\b/.test(combined)) return 'repair'
    if (/\b(check|review|does this|is this right|look right|correct\?|any issues|feedback on|what do you think)\b/.test(combined)) return 'review'
    if (/\b(what should|how should|should i|explore|options|ideas|brainstorm|help me think|what would you|thinking about)\b/.test(combined)) return 'exploration'
    return 'execution'
  } catch { return 'execution' }
}

function deriveCurrentFocusTopic(message: string, userId: string): string | null {
  try {
    const recent = db.prepare(`
      SELECT content FROM chat_messages WHERE user_id = ? AND role = 'user'
      ORDER BY created_at DESC LIMIT 3
    `).all(userId) as any[]

    const combined = [message, ...recent.map((r: any) => r.content || '')].join(' ').toLowerCase()

    const domains: Array<[string, RegExp]> = [
      ['fundraising', /\b(raise|fund|investors?|vc|angels?|round|valuation|pre-seed|seed|series\s*[ab]|cap table|term sheet)\b/],
      ['product',     /\b(product|feature|ux|design|build|ship|release|launch|roadmap|mvp|prototype)\b/],
      ['hiring',      /\b(hire|hiring|candidate|interview|team|engineer|role|job|onboard|recruit)\b/],
      ['marketing',   /\b(marketing|content|seo|ads|campaign|growth|acquisition|brand|social media)\b/],
      ['sales',       /\b(sales|deal|close|prospect|lead|customer|revenue|mrr|churn|pipeline)\b/],
      ['operations',  /\b(process|ops|workflow|system|automate|efficiency|infrastructure|deploy)\b/],
    ]
    for (const [label, re] of domains) {
      if (re.test(combined)) return label
    }
    return null
  } catch { return null }
}

function deriveRelationshipContext(userId: string, sessionId: string): string | null {
  try {
    const row = db.prepare(`
      SELECT person_name, COUNT(*) as cnt FROM channel_f_person_mentions
      WHERE user_id = ? AND session_id = ?
      GROUP BY person_name ORDER BY cnt DESC LIMIT 1
    `).get(userId, sessionId) as any
    return row?.cnt >= 2 ? row.person_name : null
  } catch { return null }
}

export function updateLiveState(userId: string, sessionId: string, message: string): void {
  try {
    const overloadCnt = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM channel_k_signals
      WHERE user_id = ? AND signal_type = 'overload'
      AND created_at >= datetime('now', '-30 minutes')
    `).get(userId) as any)?.cnt ?? 0

    const urgencyLevel = overloadCnt >= 3 ? 'critical' : overloadCnt >= 2 ? 'high' : overloadCnt >= 1 ? 'medium' : 'low'

    const kProf = db.prepare(`SELECT energy_state FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any
    const cognitiveLoad = kProf?.energy_state === 'depleted' ? 'overloaded'
      : kProf?.energy_state === 'low' ? 'high'
      : overloadCnt >= 1 ? 'moderate' : 'clear'

    const frustCnt = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM channel_a_raw_signals
      WHERE user_id = ? AND frustration_detected = 1
      AND created_at >= datetime('now', '-24 hours')
    `).get(userId) as any)?.cnt ?? 0

    const emotionalTemp = frustCnt >= 3 ? 'negative' : frustCnt >= 1 ? 'muted' : 'neutral'

    const sessionIntent = deriveSessionIntent(userId, sessionId)
    const focusTopic = deriveCurrentFocusTopic(message, userId)
    const relationshipCtx = deriveRelationshipContext(userId, sessionId)

    db.prepare(`
      INSERT INTO live_state (user_id, urgency_level, cognitive_load, emotional_temperature, current_focus_topic, relationship_context, session_intent, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        urgency_level = excluded.urgency_level,
        cognitive_load = excluded.cognitive_load,
        emotional_temperature = excluded.emotional_temperature,
        current_focus_topic = excluded.current_focus_topic,
        relationship_context = excluded.relationship_context,
        session_intent = excluded.session_intent,
        updated_at = excluded.updated_at
    `).run(userId, urgencyLevel, cognitiveLoad, emotionalTemp, focusTopic, relationshipCtx, sessionIntent)
  } catch {}
}
