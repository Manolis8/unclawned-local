import { db } from '../db.js'
import { suppressCategory, unsuppressCategory, explainScore } from './surface.js'
import { createAuthorization, revokeAuthorization, listAuthorizations } from './autonomous/authorization.js'
import { getChainLabel } from './chain.js'

const LINE = '─'.repeat(55)

export function showActionsLog(userId: string): void {
  console.log(`\n${LINE}`)
  console.log('  ACTION AUDIT  (proactive items — most recent first)')
  console.log(LINE)

  // Insights surfaced
  const rows = db.prepare(`
    SELECT am.action_category, am.surfaced_at, am.user_response, am.session_window, am.priority_score
    FROM action_memory am
    WHERE am.user_id = ?
    ORDER BY am.surfaced_at DESC
    LIMIT 15
  `).all(userId) as any[]

  if (!rows.length) {
    console.log('  No insights surfaced yet.')
  } else {
    console.log('  INSIGHTS:')
    for (const r of rows) {
      const date = r.surfaced_at?.slice(0, 10) ?? '?'
      const response = r.user_response ?? 'ignored'
      const score = r.priority_score ? ` (score ${r.priority_score.toFixed(1)})` : ''
      const window = r.session_window ? ` [${r.session_window}]` : ''
      const icon = response === 'acted' ? '✓' : response === 'dismissed' ? '✗' : response === 'engaged' ? '~' : '·'
      const chainLabel = getChainLabel(r.action_category)
      const label = chainLabel ?? r.action_category
      console.log(`  ${icon} ${date}  ${label}${window}${score}  → ${response}`)
    }
  }

  // Autonomous executions log
  try {
    const execs = db.prepare(`
      SELECT category, title, status, created_at FROM autonomous_executions
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
    `).all(userId) as any[]
    if (execs.length) {
      console.log('\n  AUTONOMOUS EXECUTIONS:')
      for (const e of execs) {
        const icon = e.status === 'confirmed' ? '✓' : e.status === 'cancelled' ? '✗' : '·'
        console.log(`  ${icon} ${e.created_at?.slice(0, 10)}  ${e.title}  → ${e.status}`)
      }
    }
  } catch {}

  // Active commitments
  try {
    const cmts = db.prepare(`
      SELECT description, trigger_type, trigger_value, due_at, status FROM commitments
      WHERE user_id = ? AND status IN ('pending','fired') ORDER BY COALESCE(due_at, created_at) ASC LIMIT 5
    `).all(userId) as any[]
    if (cmts.length) {
      console.log('\n  COMMITMENTS:')
      for (const c of cmts) {
        const due = c.due_at ? ` — due ${c.due_at.slice(0, 10)}` : c.trigger_value ? ` — when: ${c.trigger_value}` : ''
        const icon = c.status === 'fired' ? '✓' : '·'
        console.log(`  ${icon} ${c.description}${due}  → ${c.status}`)
      }
    }
  } catch {}

  // Active authorizations
  try {
    const auths = db.prepare(`
      SELECT category, auth_level, last_executed_at, expires_at FROM autonomous_authorizations
      WHERE user_id = ? AND status = 'active' ORDER BY authorized_at ASC
    `).all(userId) as any[]
    if (auths.length) {
      console.log('\n  AUTHORIZATIONS:')
      for (const a of auths) {
        const lastRun = a.last_executed_at ? a.last_executed_at.slice(0, 10) : 'never'
        const expiry = a.expires_at ? ` expires ${a.expires_at.slice(0, 10)}` : ''
        console.log(`  ✓ ${a.category}  [L${a.auth_level}]  last run: ${lastRun}${expiry}`)
      }
    }
  } catch {}

  console.log(`\n${LINE}\n`)
}

export function showActionsPending(userId: string): void {
  const rows = db.prepare(`
    SELECT id, action_category, insight_text, question_text, value_score, confidence, friction,
           priority_score, sessions_in_queue, created_at, dismiss_lock_until
    FROM action_queue
    WHERE user_id = ? AND status = 'queued'
      AND (dismiss_lock_until IS NULL OR datetime('now') > dismiss_lock_until)
    ORDER BY COALESCE(priority_score, -1) DESC, created_at ASC
  `).all(userId) as any[]

  const locked = db.prepare(`
    SELECT id, action_category, dismiss_lock_until
    FROM action_queue
    WHERE user_id = ? AND status IN ('queued','dismissed')
      AND dismiss_lock_until IS NOT NULL AND datetime('now') <= dismiss_lock_until
  `).all(userId) as any[]

  const suppressed = db.prepare(`
    SELECT category, reason, expires_at FROM action_suppression WHERE user_id = ?
  `).all(userId) as any[]

  console.log(`\n${LINE}`)
  console.log('  PENDING INSIGHTS')
  console.log(LINE)

  if (!rows.length && !locked.length) {
    console.log('  Queue is empty.')
    console.log('  Insights are added automatically as you use the agent.\n')
  } else {
    for (const r of rows) {
      const created = r.created_at?.slice(0, 10) ?? '?'
      const score = r.priority_score ? r.priority_score.toFixed(1) : '(unscored)'
      const tier = r.priority_score == null ? '?' : r.priority_score >= 7 ? 'T1' : r.priority_score >= 4 ? 'T2' : 'T3'
      const stale = r.sessions_in_queue >= 5 ? ' ⚠️ stale' : ''
      console.log(`  [${r.id.slice(0, 6)}] ${r.action_category}  score:${score} (${tier})${stale}`)
      console.log(`       ${r.insight_text.slice(0, 90)}`)
      console.log(`       added: ${created}  sessions in queue: ${r.sessions_in_queue}`)
    }

    if (locked.length) {
      console.log(`\n  Locked (dismissed, cooling down):`)
      for (const r of locked) {
        const until = r.dismiss_lock_until?.slice(0, 10) ?? '?'
        console.log(`    ${r.action_category} — locked until ${until}`)
      }
    }
  }

  if (suppressed.length) {
    console.log(`\n  Suppressed categories:`)
    for (const s of suppressed) {
      const expiry = s.expires_at ? `until ${s.expires_at.slice(0, 10)}` : 'permanently'
      console.log(`    ${s.category} — ${expiry} (${s.reason})`)
    }
  }

  showQueueHealth(userId)

  console.log(`  /actions stop <category>      — suppress a category`)
  console.log(`  /actions stop all              — silence everything`)
  console.log(`  /actions resume <category>    — unsuppress`)
  console.log(`  /actions why <id>             — score breakdown`)
  console.log(`  /actions pull <id>            — force item to Tier 1 at next session`)
  console.log(`  /actions push <id> in N days  — delay item by N days`)
  console.log(`  /actions authorize <category> — enable autonomous execution`)
  console.log(`  /actions authorized            — show active authorizations`)
  console.log(`  /actions revoke <category>    — disable autonomous execution`)
  console.log(LINE + '\n')
}

export function handleActionsStop(userId: string, args: string): void {
  const parts = args.trim().split(/\s+/)
  const category = parts[0]?.toLowerCase()
  if (!category) {
    console.log('\n  Usage: /actions stop <category|all> [for N days]\n')
    return
  }

  // Parse optional "for N days"
  let expiresAt: string | null = null
  const forMatch = args.match(/for\s+(\d+)\s+days?/i)
  if (forMatch) {
    const days = parseInt(forMatch[1])
    const d = new Date()
    d.setDate(d.getDate() + days)
    expiresAt = d.toISOString().split('T')[0]
  }

  suppressCategory(userId, category, expiresAt, 'user_command')

  const expMsg = expiresAt ? ` until ${expiresAt}` : ' permanently'
  console.log(`\n  Suppressed: ${category}${expMsg}.`)
  console.log(`  Use /actions resume ${category} to re-enable.\n`)
}

export function handleActionsResume(userId: string, category: string): void {
  if (!category) {
    console.log('\n  Usage: /actions resume <category>\n')
    return
  }
  unsuppressCategory(userId, category)
  console.log(`\n  Resumed: ${category} can surface again.\n`)
}

export function handleActionsWhy(userId: string, idPrefix: string): void {
  if (!idPrefix) {
    console.log('\n  Usage: /actions why <id>  (first 6+ chars of the ID from /actions pending)\n')
    return
  }
  const breakdown = explainScore(userId, idPrefix)
  if (!breakdown) {
    console.log(`\n  No item found starting with "${idPrefix}". Check /actions pending for IDs.\n`)
  } else {
    console.log(breakdown + '\n')
  }
}

const KNOWN_CATEGORIES = {
  session_prep: 'Prepares a daily brief at session start: pending insights, open follow-ups, last session summary.',
  relationship_touchpoints: 'Prepares a draft touchpoint message when a key contact has been quiet ≥ 14 days.',
}

export function handleActionsAuthorize(userId: string, args: string): void {
  const parts = args.trim().split(/\s+/)
  const category = parts[0]?.toLowerCase()

  if (!category || !KNOWN_CATEGORIES[category as keyof typeof KNOWN_CATEGORIES]) {
    console.log('\n  Available categories:')
    for (const [cat, desc] of Object.entries(KNOWN_CATEGORIES)) {
      console.log(`    ${cat} — ${desc}`)
    }
    console.log('\n  Usage: /actions authorize <category> [level 3]\n')
    return
  }

  // Level 3 means per-instance confirmation (still auto-prepares, but user must confirm each)
  const wantsLevel3 = /\blevel\s*3\b/.test(args)
  const level: 2 | 3 = wantsLevel3 ? 3 : 2

  createAuthorization(userId, category, level)

  const levelDesc = level === 2
    ? 'Level 2 — runs automatically, result surfaced at session start'
    : 'Level 3 — prepares the output, but waits for your confirmation before surfacing'

  console.log(`\n  ✓ Authorized: ${category}`)
  console.log(`    ${levelDesc}`)
  console.log(`    Expires in 90 days. Use /actions revoke ${category} to disable.\n`)
}

export function handleActionsRevoke(userId: string, category: string): void {
  if (!category) {
    console.log('\n  Usage: /actions revoke <category>\n')
    return
  }
  revokeAuthorization(userId, category.toLowerCase())
  console.log(`\n  Revoked: ${category} will no longer run autonomously.\n`)
}

export function showAuthorizations(userId: string): void {
  const auths = listAuthorizations(userId)
  console.log(`\n${LINE}`)
  console.log('  AUTONOMOUS AUTHORIZATIONS')
  console.log(LINE)

  if (!auths.length) {
    console.log('  No categories authorized yet.')
    console.log('  Run /actions authorize to enable automatic preparation.\n')
    console.log('  Available:')
    for (const [cat, desc] of Object.entries(KNOWN_CATEGORIES)) {
      console.log(`    ${cat} — ${desc}`)
    }
  } else {
    for (const a of auths) {
      const status = a.status === 'active' ? '✓ active' : a.status === 'expired' ? '⚠ expired' : '✗ revoked'
      const expiry = a.expires_at ? ` (expires ${a.expires_at.slice(0, 10)})` : ''
      const level = `Level ${a.auth_level}`
      const lastRun = a.last_executed_at ? ` last run: ${a.last_executed_at.slice(0, 10)}` : ' never run'
      const reversals = a.reversal_count > 0 ? ` | ${a.reversal_count} reversal${a.reversal_count > 1 ? 's' : ''}` : ''
      console.log(`  ${status}  ${a.category}  [${level}]${expiry}`)
      console.log(`           ${lastRun}${reversals}`)
      if (a.reversal_count >= 3 && a.auth_level === 3) {
        console.log(`           ⚠  De-escalated to Level 3 due to reversals — use /actions authorize ${a.category} to reset`)
      }
    }
  }

  console.log(LINE + '\n')
}

// /actions pull <id> — force an item to Tier 1 at next session start
export function handleActionsPull(userId: string, idPrefix: string): void {
  if (!idPrefix) {
    console.log('\n  Usage: /actions pull <id>  (from /actions pending)\n')
    return
  }
  const action = db.prepare(`SELECT * FROM action_queue WHERE user_id = ? AND id LIKE ?`).get(userId, `${idPrefix}%`) as any
  if (!action) {
    console.log(`\n  No item found starting with "${idPrefix}".\n`)
    return
  }
  // Set priority_score above Tier 1 threshold so it surfaces at next session start
  db.prepare(`UPDATE action_queue SET priority_score = 10.0 WHERE id = ?`).run(action.id)
  console.log(`\n  ✓ "${action.action_category}" promoted — will surface at next session start.\n`)
}

// /actions push <id> in N days — delay an item (uses dismiss_lock_until as the delay mechanism)
export function handleActionsPush(userId: string, args: string): void {
  const idMatch = args.match(/^(\S+)/)
  const daysMatch = args.match(/\bin\s+(\d+)\s*(day|days|week|weeks)\b/i)
  if (!idMatch || !daysMatch) {
    console.log('\n  Usage: /actions push <id> in N days\n')
    return
  }
  const idPrefix = idMatch[1]
  const n = parseInt(daysMatch[1])
  const isWeeks = /week/i.test(daysMatch[2])
  const days = isWeeks ? n * 7 : n

  const action = db.prepare(`SELECT * FROM action_queue WHERE user_id = ? AND id LIKE ?`).get(userId, `${idPrefix}%`) as any
  if (!action) {
    console.log(`\n  No item found starting with "${idPrefix}".\n`)
    return
  }
  const lockUntil = new Date(Date.now() + days * 86400000)
    .toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(`UPDATE action_queue SET dismiss_lock_until = ? WHERE id = ?`).run(lockUntil, action.id)
  console.log(`\n  Pushed: "${action.action_category}" will not surface until ${lockUntil.slice(0, 10)}.\n`)
}

export function showQueueHealth(userId: string): void {
  const queued = db.prepare(`SELECT COUNT(*) as c FROM action_queue WHERE user_id = ? AND status = 'queued'`).get(userId) as any
  const tier3 = db.prepare(`
    SELECT COUNT(*) as c FROM action_queue
    WHERE user_id = ? AND status = 'queued' AND priority_score IS NOT NULL AND priority_score < 4.0
  `).get(userId) as any
  const recentDismissals = db.prepare(`
    SELECT COUNT(*) as c FROM action_memory
    WHERE user_id = ? AND user_response = 'dismissed'
      AND datetime(surfaced_at) > datetime('now', '-30 days')
  `).get(userId) as any
  const total30 = db.prepare(`
    SELECT COUNT(*) as c FROM action_memory
    WHERE user_id = ? AND datetime(surfaced_at) > datetime('now', '-30 days')
  `).get(userId) as any

  const warnings: string[] = []
  if ((queued?.c ?? 0) > 5) warnings.push(`Queue bloat: ${queued.c} items pending — thresholds may be too loose`)
  if ((tier3?.c ?? 0) >= 3) warnings.push(`Stagnation: ${tier3.c} Tier-3 items may never surface — check timing fit`)
  if (total30?.c > 0) {
    const dismissRate = Math.round(((recentDismissals?.c ?? 0) / total30.c) * 100)
    if (dismissRate > 40) warnings.push(`High dismissal rate: ${dismissRate}% — insights may not be relevant yet`)
  }

  if (warnings.length) {
    console.log(`\n  Queue health warnings:`)
    warnings.forEach(w => console.log(`    ⚠️  ${w}`))
    console.log()
  }
}
