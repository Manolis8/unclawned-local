import { db, uuid } from '../db.js'

function classifyType(phrase: string): string {
  const p = phrase.toLowerCase()
  if (/\b(bullet|list|format|numbered|table|headers?)\b/.test(p)) return 'format'
  if (/\b(tone|formal|casual|professional|friendly|brief|short|long|detail|tldr)\b/.test(p)) return 'tone'
  if (/\b(scope|focus|stick|only|just|limit|expand|adjacent)\b/.test(p)) return 'scope'
  if (/\b(person|name|contact|reach out|email|message|them|he|she)\b/.test(p)) return 'relationship'
  if (/\b(topic|about|area|domain|subject|field)\b/.test(p)) return 'domain'
  return 'format'
}

export function detectAndSaveDirectives(userId: string, message: string, context: string = ''): void {
  try {
    const lower = message.toLowerCase()
    const candidates: Array<{ phrase: string; polarity: string }> = []

    const tryMatch = (re: RegExp, polarity: string) => {
      const m = lower.match(re)
      if (m) candidates.push({ phrase: m[0].trim(), polarity })
    }

    // Skip "I always" / "you always" — those are statements, not instructions to the agent
    if (!/\b(i|you)\s+always\b/.test(lower)) {
      tryMatch(/\b(?:always|every time|whenever i ask)\b[^.!?\n]{3,120}/, 'always')
    }
    // Skip "I never" / "you never" — statements not instructions
    if (!/\b(i|you)\s+never\b/.test(lower)) {
      tryMatch(/\b(?:never|don'?t ever|do not ever)\b[^.!?\n]{3,120}/, 'never')
    }
    tryMatch(/\bfrom now on\b[^.!?\n]{3,120}/, 'from_now_on')
    tryMatch(/\bstop\b[^.!?\n]{3,80}/, 'stop')
    // "don't" only when it starts the message (or follows "please") — avoids "I don't know X" false positives
    const dontStart = lower.trim().match(/^(?:please\s+)?don'?t\b[^.!?\n]{5,100}/)
    if (dontStart) candidates.push({ phrase: dontStart[0].trim(), polarity: 'never' })

    for (const { phrase, polarity } of candidates) {
      const directiveType = classifyType(phrase)
      db.prepare(`
        INSERT INTO behavioral_contract (id, user_id, directive_type, directive_key, directive_value, stated_at, stated_in_context, active)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, 1)
      `).run(uuid(), userId, directiveType, polarity, phrase, context.slice(0, 200))
    }
  } catch {}
}

export function getActiveDirectives(userId: string): Array<{
  id: string; directive_type: string; directive_key: string; directive_value: string; stated_at: string
}> {
  try {
    return db.prepare(`
      SELECT id, directive_type, directive_key, directive_value, stated_at
      FROM behavioral_contract WHERE user_id = ? AND active = 1
      ORDER BY stated_at DESC
    `).all(userId) as any[]
  } catch { return [] }
}

export function revokeDirective(id: string): void {
  try {
    db.prepare(`
      UPDATE behavioral_contract SET active = 0, revoked_at = datetime('now') WHERE id = ?
    `).run(id)
  } catch {}
}

export function addExplicitDirective(userId: string, directiveValue: string, context: string = ''): void {
  try {
    const directiveType = classifyType(directiveValue)
    db.prepare(`
      INSERT INTO behavioral_contract (id, user_id, directive_type, directive_key, directive_value, stated_at, stated_in_context, active)
      VALUES (?, ?, ?, 'manual', ?, datetime('now'), ?, 1)
    `).run(uuid(), userId, directiveType, directiveValue, context.slice(0, 200))
  } catch {}
}
