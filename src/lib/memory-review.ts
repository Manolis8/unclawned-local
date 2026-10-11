import { resolveRuntime } from './model-router.js'
import { db, uuid } from './db.js'
import { getProfile, setProfileField, ProfileKey } from './user-profile.js'
import {
  initMemoryMd, appendToSection, isNearCapacity,
  trimOldestProjectEntries, applyStaleMarking, getSectionContent,
} from './memory.js'
import { appendObservationToContextFile } from './context-files.js'
import { checkRepetitionTrigger, addSuggestion, archiveStale } from './suggestions.js'
import { addOpenItem } from './open-items/tracker.js'

const _rt = () => resolveRuntime()

// Detectors run at most once every 4 hours per user — prevents spamming on every task
const _lastDetectorRun: Record<string, number> = {}
const DETECTOR_INTERVAL_MS = 4 * 60 * 60 * 1000

export interface TaskDigest {
  taskPrompt: string
  taskSummary: string
  taskType: 'browser' | 'local' | 'chat' | 'hybrid'
  outcome: 'completed' | 'failed'
  durationSeconds: number
  userId?: string
  cliSessionId?: string
}

// ─── Session archival ─────────────────────────────────────────────────────────

export function archiveSession(digest: TaskDigest): void {
  const userId = digest.userId ?? 'local'
  const id = uuid()
  try {
    db.prepare(`
      INSERT INTO agent_sessions (id, user_id, task_prompt, task_summary, task_type, outcome, duration_seconds, cli_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, digest.taskPrompt, digest.taskSummary.slice(0, 800), digest.taskType, digest.outcome, digest.durationSeconds, digest.cliSessionId ?? null)

    db.prepare(`
      INSERT INTO agent_sessions_fts (session_id, task_prompt, task_summary)
      VALUES (?, ?, ?)
    `).run(id, digest.taskPrompt, digest.taskSummary.slice(0, 800))
  } catch {
    // Non-fatal — session archival failure shouldn't break anything
  }
}

// ─── Session search ───────────────────────────────────────────────────────────

export function searchSessions(query: string, userId = 'local'): Array<{ task_prompt: string; task_summary: string; created_at: string }> {
  try {
    const ftsResults = db.prepare(`
      SELECT session_id FROM agent_sessions_fts
      WHERE agent_sessions_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `).all(query) as any[]

    if (!ftsResults.length) return []

    const ids = ftsResults.map(r => r.session_id)
    const placeholders = ids.map(() => '?').join(',')
    return db.prepare(`
      SELECT task_prompt, task_summary, created_at FROM agent_sessions
      WHERE id IN (${placeholders}) AND user_id = ?
      ORDER BY created_at DESC
    `).all(...ids, userId) as any[]
  } catch {
    return []
  }
}

// ─── Pending memory ───────────────────────────────────────────────────────────

export function getPendingMemory(userId = 'local') {
  return db.prepare(`
    SELECT * FROM memory_pending WHERE user_id = ? AND status = 'pending' ORDER BY created_at ASC
  `).all(userId) as any[]
}

export function approvePendingEntry(id: string): void {
  const row = db.prepare('SELECT * FROM memory_pending WHERE id = ?').get(id) as any
  if (!row) return
  if (row.section === 'USER_PROFILE') {
    // proposed_entry is "key: value" format
    const colonIdx = row.proposed_entry.indexOf(': ')
    if (colonIdx > 0) {
      const key = row.proposed_entry.slice(0, colonIdx).trim() as ProfileKey
      const value = row.proposed_entry.slice(colonIdx + 2).trim()
      setProfileField(key, value)
    }
  } else {
    appendToSection(row.section, row.proposed_entry)
  }
  db.prepare("UPDATE memory_pending SET status = 'approved' WHERE id = ?").run(id)
}

export function dismissPendingEntry(id: string): void {
  db.prepare("UPDATE memory_pending SET status = 'dismissed' WHERE id = ?").run(id)
}

export function getPendingCount(userId = 'local'): number {
  const row = db.prepare("SELECT COUNT(*) as c FROM memory_pending WHERE user_id = ? AND status = 'pending'").get(userId) as any
  return row?.c ?? 0
}

// ─── Duplication check ────────────────────────────────────────────────────────

function isDuplicateEntry(section: string, needle: string): boolean {
  const existing = getSectionContent(section as any)
  if (!existing) return false
  // Normalize: lowercase, collapse whitespace, strip punctuation for comparison
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const needleNorm = normalize(needle.slice(0, 80))
  return existing.split('\n').some(line => {
    const lineNorm = normalize(line.slice(0, 80))
    // Match if the entry's first 60 normalized chars are identical (same date+name)
    return lineNorm.slice(0, 60) === needleNorm.slice(0, 60) && lineNorm.length > 10
  })
}

// ─── Write helper: direct or staged ──────────────────────────────────────────

function writeOrStage(
  section: string,
  entry: string,
  reason: string,
  userId: string,
  onDirectWrite?: () => void
): void {
  const profile = getProfile(userId)
  const writeApproval = profile.write_approval === 'on'

  if (writeApproval) {
    db.prepare(`
      INSERT INTO memory_pending (id, user_id, section, proposed_entry, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), userId, section, entry, reason)
    // Context file sync deferred until user approves — skip for now
  } else {
    appendToSection(section as any, entry)
    onDirectWrite?.()
  }
}

// ─── Background review ────────────────────────────────────────────────────────

interface PersonResult {
  name: string
  identifiers: string[]   // must have 2+ for entry to be created
  role: string
  platform?: string
  notes: string
}

interface PlatformObservationResult {
  platform: string
  category: 'content' | 'navigation' | 'timing' | 'engagement' | 'other'
  observation: string
}

interface UserProfileUpdate {
  field: string   // must be a valid ProfileKey
  value: string
  reason: string  // why this was inferred from the task
}

interface OpenItemResult {
  type: string
  summary: string
  context: string | null
  related_person: string | null
  follow_up_days: number
}

interface ReviewOutput {
  diary_entry: string | null
  person: PersonResult | null
  platform_observation: PlatformObservationResult | null
  lesson: string | null
  user_profile_update: UserProfileUpdate | null
  open_item: OpenItemResult | null
}

export async function runBackgroundReview(digest: TaskDigest): Promise<void> {
  const userId = digest.userId ?? 'local'

  if (digest.outcome === 'failed' && digest.durationSeconds < 5) return
  if (digest.taskType === 'local' && digest.durationSeconds < 10) return

  initMemoryMd()
  archiveSession(digest)
  archiveStale()

  if (isNearCapacity()) trimOldestProjectEntries()
  applyStaleMarking()

  const today = new Date().toISOString().split('T')[0]

  try {
    const response = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('low'),
      max_tokens: 650,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You extract memory entries for a personal AI agent's MEMORY.md and user profile.

Return ONLY valid JSON (no markdown, no backticks):
{
  "diary_entry": "string or null",
  "person": {
    "name": "Full Name",
    "identifiers": ["Company: Acme", "@handle"],
    "role": "their role/title",
    "platform": "LinkedIn",
    "notes": "what they talk about, reach, current focus — max 20 words"
  } or null,
  "platform_observation": {
    "platform": "LinkedIn",
    "category": "content",
    "observation": "specific reusable observation"
  } or null,
  "lesson": "string or null",
  "user_profile_update": {
    "field": "profile_field_name",
    "value": "new value",
    "reason": "why this was inferred"
  } or null,
  "open_item": {
    "type": "email_sent",
    "summary": "Sent cold email to YC Combinator",
    "context": "fundraising",
    "related_person": "YC",
    "follow_up_days": 3
  } or null
}

RULES:

diary_entry: "${today}: [what was done and outcome]". 1-2 sentences. Always create unless task was trivial (under 10s).

person: ONLY if a specific named individual was directly researched or interacted with.
- "identifiers" MUST have at least 2 items. Valid identifiers: company name, @handle, email, job title+company, profile URL.
- If fewer than 2 identifiers are known from the task output, return null — do not guess.
- Format identifiers as: "Company: Name", "@handle", "email@...", "Title at Company".

platform_observation: ONLY for web platform tasks. Must be specific and reusable (not obvious).
- LinkedIn categories: content (post formats/topics that get engagement), timing (best times), engagement (what drives comments/likes), navigation (UI patterns to know).
- Twitter categories: content (thread vs single tweet), timing, engagement, feed curation.
- Gmail categories: email patterns (subject lines, response rates), threading, organization.
- Other platforms: use "other" category.
- Do NOT create if the observation is generic ("LinkedIn is a professional network") or already obvious.

lesson: Something that worked/failed that will still matter 30 days from now. Max 15 words. null if nothing notable.

user_profile_update: ONLY if the user explicitly stated a NEW preference, corrected something, or revealed a goal not already captured.
- Valid fields: name, role, company_name, company_description, target_customer, current_goals, success_metric, automate_most, never_without_asking, autonomy_rules, expertise_areas, learning_areas, formality, banned_phrases
- Do NOT infer — only capture things the user DIRECTLY stated in the task prompt.
- null if nothing new was stated about the user themselves.

open_item: Create ONLY if the task involves something with a clear expected follow-up that the user would want to be reminded about.
- Valid types: "email_sent", "pitch_made", "meeting_scheduled", "application_submitted", "document_sent", "message_sent", "proposal_made", "request_made"
- summary: short past-tense description of what happened ("Sent cold email to YC Combinator")
- context: the broader initiative this belongs to ("fundraising", "hiring", "sales outreach") or null
- related_person: the person or company this was sent to, or null
- follow_up_days: how many days before a follow-up makes sense (2 for emails, 3 for pitches, 7 for applications)
- Only create if the task COMPLETED successfully and involves an outbound action to another person/org.
- null if the task was internal, browsing, writing for self, or no natural follow-up exists.

Return null for any field when uncertain. Conservative is better.`
        },
        {
          role: 'user',
          content: `Task: ${digest.taskPrompt}
Type: ${digest.taskType}
Outcome: ${digest.outcome} (${digest.durationSeconds}s)
Output summary: ${digest.taskSummary.slice(0, 700)}`
        }
      ]
    })

    const text = response.choices[0].message.content?.trim() || '{}'
    const clean = text.replace(/```json|```/g, '').trim()
    const result: ReviewOutput = JSON.parse(clean)

    if (result.diary_entry && !isDuplicateEntry('PROJECTS', result.diary_entry)) {
      writeOrStage('PROJECTS', result.diary_entry, 'Task diary entry', userId)
    }

    if (result.person && Array.isArray(result.person.identifiers) && result.person.identifiers.length >= 2) {
      const { name, identifiers, role, platform, notes } = result.person
      const idStr = identifiers.slice(0, 3).join(', ')
      const entry = `${today}: ${name} (${idStr}${platform ? `, ${platform}` : ''}) — ${role}. ${notes}`
      if (!isDuplicateEntry('PEOPLE', entry)) {
        writeOrStage('PEOPLE', entry, `Person encountered: ${name}`, userId)
      }
    }

    if (result.platform_observation) {
      const { platform, category, observation } = result.platform_observation
      const entry = `${today} [${platform}/${category}]: ${observation}`
      writeOrStage('PLATFORM OBSERVATIONS', entry, `Platform observation: ${platform}`, userId, () => {
        // Sync to context file on direct write (not when staged for approval)
        try { appendObservationToContextFile(platform.toLowerCase(), observation, today) } catch {}
      })
    }

    if (result.lesson) {
      writeOrStage('LESSONS', `${today}: ${result.lesson}`, 'Lesson learned', userId)
    }

    if (result.user_profile_update) {
      const { field, value, reason } = result.user_profile_update
      const validFields = ['name','role','company_name','company_description','target_customer','current_goals','success_metric','automate_most','never_without_asking','autonomy_rules','expertise_areas','learning_areas','formality','banned_phrases']
      if (validFields.includes(field) && value.trim()) {
        // Always stage for approval — never auto-write USER.md
        db.prepare(`INSERT INTO memory_pending (id, user_id, section, proposed_entry, reason) VALUES (?, ?, ?, ?, ?)`).run(
          uuid(), userId, 'USER_PROFILE', `${field}: ${value}`, `User stated: ${reason}`
        )
      }
    }

    if (result.open_item && result.open_item.summary && digest.outcome === 'completed') {
      const oi = result.open_item
      addOpenItem(
        userId,
        oi.type,
        oi.summary,
        oi.context ?? null,
        oi.related_person ?? null,
        oi.follow_up_days ?? 3
      )
    }

    // Repetition trigger — suggest automation when same task runs 3x in 30 days
    const repeated = checkRepetitionTrigger(digest.taskPrompt, userId)
    if (repeated) {
      const shortTask = repeated.trim().slice(0, 60).replace(/^(go to|open|navigate to)\s+/i, '')
      addSuggestion(
        `"${shortTask}" runs often — consider a scheduled skill or shortcut`,
        'repeated 3x in 30 days'
      )
    }

    // Continuity: auto-detect in-progress tasks and time-based commitments from task output
    try {
      const { detectsContinuationIntent, saveInProgress } = await import('./continuity/inprogress.js')
      const { createCommitment } = await import('./continuity/commitments.js')

      if (digest.outcome === 'completed' && detectsContinuationIntent(digest.taskSummary)) {
        saveInProgress(userId, digest.taskPrompt, digest.taskSummary, null, null)
      }

      // Extract time-based commitments from the task summary ("I'll follow up in X days", "check back in X days")
      const commitMatch = digest.taskSummary.match(/(?:follow up|check back|remind|revisit)\s+in\s+(\d+)\s+(day|days|week|weeks)/i)
      if (commitMatch) {
        const n = parseInt(commitMatch[1])
        const isWeeks = /week/i.test(commitMatch[2])
        const days = isWeeks ? n * 7 : n
        createCommitment(userId, 'time_based', `Follow up on: ${digest.taskPrompt.slice(0, 60)}`, 'after_N_days', String(days), digest.taskPrompt.slice(0, 120))
      }
    } catch {}

    // Run insight generators at most once every 4 hours per user
    const now = Date.now()
    if (!_lastDetectorRun[userId] || now - _lastDetectorRun[userId] >= DETECTOR_INTERVAL_MS) {
      _lastDetectorRun[userId] = now
      try {
        const { detectRelationshipCooling } = await import('./action-engine/insights/relationship-cooling.js')
        const { detectFocusDrift } = await import('./action-engine/insights/focus-drift.js')
        const { detectTimingPattern } = await import('./action-engine/insights/timing-observation.js')
        const { detectHiddenPriority } = await import('./action-engine/insights/hidden-priority.js')
        const { detectRelationshipOpportunity } = await import('./action-engine/insights/relationship-opportunity.js')
        const { detectBlockingPattern } = await import('./action-engine/insights/blocking-pattern.js')
        const { detectTimeTrap } = await import('./action-engine/insights/time-trap.js')
        const { detectIdentityDrift } = await import('./action-engine/insights/identity-drift.js')
        const { detectCapabilityCeiling } = await import('./action-engine/insights/capability-ceiling.js')
        const { applyMemoryFeedback, archiveStaleInsights } = await import('./action-engine/surface.js')
        detectRelationshipCooling(userId)
        detectFocusDrift(userId)
        detectTimingPattern(userId)
        detectHiddenPriority(userId)
        detectRelationshipOpportunity(userId)
        detectBlockingPattern(userId)
        detectTimeTrap(userId)
        detectIdentityDrift(userId)
        detectCapabilityCeiling(userId)
        applyMemoryFeedback(userId)
        archiveStaleInsights(userId)
      } catch {}
    }

    // Regenerate user-long-term.md once per day (async, non-blocking)
    try {
      const lastGen = db.prepare(`SELECT value FROM user_profile WHERE user_id = ? AND key = 'long_term_updated_at'`).get(userId) as any
      const hoursSince = lastGen?.value
        ? (Date.now() - new Date(lastGen.value).getTime()) / (1000 * 60 * 60)
        : 9999
      if (hoursSince >= 23) {
        const { generateAndSaveLongTermMd } = await import('./long-term/generator.js')
        generateAndSaveLongTermMd(userId).catch(() => {})
      }
    } catch {}

  } catch {
    // Non-fatal
  }
}
