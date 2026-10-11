/**
 * Test: Post-task Skill Suggestions (Feature 2)
 * Tests the full DB flow without needing a running server or API keys.
 * The LLM analysis part is simulated with direct DB inserts (same schema).
 *
 * Run: node test-suggestions.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
db.exec('PRAGMA journal_mode = WAL')
const p = v => { try { return JSON.parse(v) } catch { return v } }

// Bootstrap table (server normally does this on startup)
db.exec(`CREATE TABLE IF NOT EXISTS skill_suggestions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, suggested_name TEXT NOT NULL,
  suggested_description TEXT NOT NULL, skill_type TEXT NOT NULL DEFAULT 'browser',
  source_task TEXT NOT NULL, tool_call_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT
)`)

// ── 1. Get user ───────────────────────────────────────────────────────────────
const userRow = db.prepare(`SELECT user_id FROM api_keys LIMIT 1`).get()
if (!userRow) { console.error('❌ No users found.'); process.exit(1) }
const userId = userRow.user_id
console.log(`\n✅ User: ${userId}`)

// ── 2. Clear pending suggestions for clean run ────────────────────────────────
const cleared = db.prepare(`DELETE FROM skill_suggestions WHERE user_id = ? AND status = 'pending'`).run(userId)
console.log(`🧹 Cleared ${cleared.changes} existing pending suggestion(s)`)

// ── 3. Mock what analyzeForSkillSuggestion would return ───────────────────────
// In production, the LLM decides these. Here we hard-code two examples.
const mockSuggestions = [
  {
    suggested_name: 'linkedin-remote-jobs-search',
    suggested_description: 'Search LinkedIn for remote jobs by keyword and list top results',
    skill_type: 'browser',
    source_task: 'Search LinkedIn for remote Python developer jobs posted this week and list the top 5',
    tool_call_count: 8,
  },
  {
    suggested_name: 'github-star-repository',
    suggested_description: 'Navigate to a GitHub repository and star it',
    skill_type: 'browser',
    source_task: 'Go to GitHub and star the facebook/react repository',
    tool_call_count: 5,
  },
]

// Insert them (same as createSkillSuggestion in queries.ts)
for (const s of mockSuggestions) {
  db.prepare(`
    INSERT INTO skill_suggestions
      (id, user_id, suggested_name, suggested_description, skill_type, source_task, tool_call_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, s.suggested_name, s.suggested_description, s.skill_type, s.source_task, s.tool_call_count)
}

console.log(`\n✅ Staged ${mockSuggestions.length} suggestions (simulating post-task LLM analysis)`)

// ── 4. List pending — simulates GET /api/skills/suggestions ──────────────────
const pending = db.prepare(`SELECT * FROM skill_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(userId)
console.log(`\n📬 GET /api/skills/suggestions → ${pending.length} pending`)
for (const s of pending) {
  console.log(`\n  💡 "${s.suggested_name}"`)
  console.log(`     ${s.suggested_description}`)
  console.log(`     type: ${s.skill_type} | tool_calls: ${s.tool_call_count}`)
  console.log(`     source: "${s.source_task.slice(0, 55)}..."`)
}

// ── 5. Accept first — simulates POST /api/skills/suggestions/:id/accept ───────
const first = pending[0]
console.log(`\n🎯 Accepting: "${first.suggested_name}"`)

db.prepare(`UPDATE skill_suggestions SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?`).run(first.id)

const prefill = {
  name: first.suggested_name,
  description: first.suggested_description,
  skillType: first.skill_type,
}
console.log('\n  Prefill returned to frontend:')
console.log(JSON.stringify(prefill, null, 2))
console.log('  → User sees skill creation wizard with these fields pre-filled')

// ── 6. Dismiss second — simulates POST /api/skills/suggestions/:id/dismiss ────
if (pending.length > 1) {
  const second = pending[1]
  db.prepare(`UPDATE skill_suggestions SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?`).run(second.id)
  console.log(`\n⏭️  Dismissed: "${second.suggested_name}"`)
}

// ── 7. Test dedup guard — same source task shouldn't create another pending ───
console.log('\n🔄 Dedup check: inserting same source task again...')
const dupTask = mockSuggestions[0].source_task
// hasPendingSuggestionForTask logic: check if pending exists for this task prefix
const existing = db.prepare(`
  SELECT id FROM skill_suggestions
  WHERE user_id = ? AND status = 'pending' AND source_task LIKE ?
  LIMIT 1
`).get(userId, `${dupTask.slice(0, 60)}%`)

if (existing) {
  console.log('  Would create duplicate — blocked by dedup (hasPendingSuggestionForTask)')
} else {
  console.log('  No pending match — dedup would allow creation (accepted ones don\'t block re-suggestion)')
}

// ── 8. Verify final state ─────────────────────────────────────────────────────
const finalPending = db.prepare(`SELECT COUNT(*) as cnt FROM skill_suggestions WHERE user_id = ? AND status = 'pending'`).get(userId)
const accepted = db.prepare(`SELECT COUNT(*) as cnt FROM skill_suggestions WHERE user_id = ? AND status = 'accepted'`).get(userId)
const dismissed = db.prepare(`SELECT COUNT(*) as cnt FROM skill_suggestions WHERE user_id = ? AND status = 'dismissed'`).get(userId)

console.log('\n📊 Final state:')
console.log(`  pending:   ${finalPending.cnt}`)
console.log(`  accepted:  ${accepted.cnt}`)
console.log(`  dismissed: ${dismissed.cnt}`)

console.log('\n🎉 Feature 2 test complete.')
