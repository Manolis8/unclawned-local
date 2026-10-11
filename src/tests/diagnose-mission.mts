import { db } from '../lib/db.js'

const MID = 'd082ff71'

// Find mission
const missions = db.prepare("SELECT id, goal, status, pool_size, token_summary, created_at FROM missions WHERE id LIKE ?").all('%' + MID + '%') as any[]
console.log('\n=== MISSION ===')
for (const m of missions) {
  console.log('id:', m.id)
  console.log('goal:', m.goal)
  console.log('status:', m.status)
  console.log('pool_size:', m.pool_size)
  console.log('token_summary:', m.token_summary?.slice(0, 2000))
}

if (missions.length === 0) {
  console.log('No mission found with id containing', MID)
  // list recent missions
  const recent = db.prepare("SELECT id, goal, status, created_at FROM missions ORDER BY created_at DESC LIMIT 10").all() as any[]
  console.log('\nRecent missions:')
  for (const m of recent) console.log(' ', m.id, '|', m.status, '|', m.goal?.slice(0, 60))
  process.exit(0)
}

const missionId = missions[0].id

// Jobs
const jobs = db.prepare("SELECT id, description, status, tool_set, attempts, max_attempts, output_summary, retry_context FROM jobs WHERE mission_id = ? ORDER BY created_at").all(missionId) as any[]
console.log('\n=== JOBS ===')
for (const j of jobs) {
  console.log('  id:', j.id.slice(0, 8))
  console.log('  desc:', j.description)
  console.log('  status:', j.status, '| toolSet:', j.tool_set, '| attempts:', j.attempts, '/', j.max_attempts)
  console.log('  output_summary:', j.output_summary?.slice(0, 500))
  console.log('  retry_context:', j.retry_context?.slice(0, 300))
  console.log('  ---')
}

// Artifacts
const arts = db.prepare("SELECT key, value FROM artifacts WHERE mission_id = ? ORDER BY key").all(missionId) as any[]
console.log('\n=== ARTIFACTS ===')
for (const a of arts) {
  console.log('KEY:', a.key)
  console.log('VALUE:', a.value?.slice(0, 3000))
  console.log('---')
}

// Divisions
const divs = db.prepare("SELECT id, role, status, goal, output_summary FROM divisions WHERE mission_id = ? ORDER BY created_at").all(missionId) as any[]
console.log('\n=== DIVISIONS ===')
for (const d of divs) {
  console.log('  role:', d.role, '| status:', d.status)
  console.log('  goal:', d.goal?.slice(0, 100))
  console.log('  output_summary:', d.output_summary?.slice(0, 400))
  console.log('  ---')
}

// Events
const events = db.prepare("SELECT type, payload, created_at FROM mission_events WHERE mission_id = ? ORDER BY created_at").all(missionId) as any[]
console.log('\n=== EVENTS ===')
for (const e of events) {
  const pay = typeof e.payload === 'string' ? e.payload?.slice(0, 200) : JSON.stringify(e.payload)?.slice(0, 200)
  console.log(e.created_at, '|', e.type, '|', pay)
}

// Token calls
const tokenCalls = db.prepare("SELECT * FROM mission_token_calls WHERE mission_id = ? ORDER BY created_at").all(missionId) as any[]
console.log('\n=== TOKEN CALLS ===')
if (tokenCalls.length === 0) {
  console.log('(no mission_token_calls table or no rows)')
  // Try task_logs for related tasks
  const taskLogs = db.prepare("SELECT id, user_id, user_prompt, status, total_time, created_at FROM task_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all('local') as any[]
  console.log('\nRecent task_logs:')
  for (const t of taskLogs) console.log(' ', t.id?.slice(0,8), '|', t.status, '|', t.user_prompt?.slice(0,60))
} else {
  for (const t of tokenCalls) console.log(JSON.stringify(t))
}

process.exit(0)
