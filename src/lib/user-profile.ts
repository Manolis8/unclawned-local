import { db, uuid } from './db.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveRuntime } from './model-router.js'

const _rt = () => resolveRuntime()

export const JARVIS_DIR = path.join(os.homedir(), '.unclawned')
export const USER_MD_PATH = path.join(JARVIS_DIR, 'USER.md')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserProfile {
  // Identity
  name?: string
  role?: string
  company_name?: string
  company_description?: string
  target_customer?: string
  // Voice
  formality?: string
  emoji_usage?: string
  message_length?: string
  banned_phrases?: string
  natural_phrases?: string
  voice_profile?: string
  // Platforms
  email_client?: string
  social_platforms?: string
  crm_tool?: string
  notes_tool?: string
  important_folders?: string
  // Goals
  current_goals?: string
  success_metric?: string
  automate_most?: string
  goals_updated_at?: string
  // Autonomy
  never_without_asking?: string
  autonomy_rules?: string
  // Domain knowledge
  expertise_areas?: string
  learning_areas?: string
  // Memory settings
  write_approval?: string
}

export type ProfileKey = keyof UserProfile

// ─── DB read / write ──────────────────────────────────────────────────────────

export function getProfile(userId = 'local'): UserProfile {
  const rows = db.prepare('SELECT key, value FROM user_profile WHERE user_id = ?').all(userId) as any[]
  const profile: UserProfile = {}
  for (const { key, value } of rows) {
    (profile as any)[key] = value
  }
  return profile
}

export function setProfileField(key: ProfileKey, value: string, userId = 'local'): void {
  db.prepare(`
    INSERT INTO user_profile (user_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, key, value)
}

export function setProfileFields(fields: Partial<UserProfile>, userId = 'local'): void {
  const stmt = db.prepare(`
    INSERT INTO user_profile (user_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)
  db.exec('BEGIN')
  try {
    for (const [key, value] of Object.entries(fields)) {
      if (value != null && value !== '') stmt.run(userId, key, String(value))
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

export function isProfileEmpty(userId = 'local'): boolean {
  const row = db.prepare('SELECT COUNT(*) as c FROM user_profile WHERE user_id = ?').get(userId) as any
  return (row?.c ?? 0) === 0
}

export function isProfileUsable(userId = 'local'): boolean {
  const p = getProfile(userId)
  return !!(p.name || p.role || p.current_goals)
}

// ─── Goals freshness ──────────────────────────────────────────────────────────

export function getGoalsFreshness(userId = 'local'): { stale: boolean; daysOld: number; dateStr: string } {
  const p = getProfile(userId)
  if (!p.goals_updated_at) return { stale: false, daysOld: 0, dateStr: '' }
  const updated = new Date(p.goals_updated_at)
  const daysOld = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24))
  return {
    stale: daysOld >= 14,
    daysOld,
    dateStr: p.goals_updated_at.split('T')[0],
  }
}

// ─── USER.md generation ───────────────────────────────────────────────────────

export function generateUserMd(profile: UserProfile): string {
  const parts: string[] = []

  const hasIdentity = profile.name || profile.role || profile.company_name
  if (hasIdentity) {
    const lines = ['**About the user:**']
    if (profile.name) lines.push(`- Name: ${profile.name}`)
    if (profile.role) lines.push(`- Role: ${profile.role}`)
    if (profile.company_name) {
      const desc = profile.company_description ? ` — ${profile.company_description}` : ''
      lines.push(`- Company: ${profile.company_name}${desc}`)
    }
    if (profile.target_customer) lines.push(`- Customers: ${profile.target_customer}`)
    parts.push(lines.join('\n'))
  }

  const hasVoice = profile.voice_profile || profile.formality || profile.banned_phrases || profile.emoji_usage
  if (hasVoice) {
    const lines = ['**Communication style:**']
    if (profile.voice_profile) lines.push(`- Voice: ${profile.voice_profile}`)
    if (profile.formality) lines.push(`- Tone: ${profile.formality}`)
    if (profile.emoji_usage) lines.push(`- Emojis: ${profile.emoji_usage}`)
    if (profile.message_length) lines.push(`- Length: ${profile.message_length}`)
    if (profile.banned_phrases) lines.push(`- NEVER use these words/phrases: ${profile.banned_phrases}`)
    if (profile.natural_phrases) lines.push(`- Phrases I naturally use: ${profile.natural_phrases}`)
    parts.push(lines.join('\n'))
  }

  const hasPlatforms = profile.email_client || profile.social_platforms || profile.important_folders
  if (hasPlatforms) {
    const lines = ['**Tools & platforms:**']
    if (profile.email_client) lines.push(`- Email: ${profile.email_client}`)
    if (profile.social_platforms) lines.push(`- Social: ${profile.social_platforms}`)
    if (profile.crm_tool) lines.push(`- CRM: ${profile.crm_tool}`)
    if (profile.notes_tool) lines.push(`- Notes: ${profile.notes_tool}`)
    if (profile.important_folders) lines.push(`- Key folders: ${profile.important_folders}`)
    parts.push(lines.join('\n'))
  }

  const hasGoals = profile.current_goals || profile.success_metric || profile.automate_most
  if (hasGoals) {
    const lines = ['**Current goals:**']
    if (profile.current_goals) lines.push(`- Working on: ${profile.current_goals}`)
    if (profile.success_metric) lines.push(`- Success this month: ${profile.success_metric}`)
    if (profile.automate_most) lines.push(`- Wants automated: ${profile.automate_most}`)
    parts.push(lines.join('\n'))
  }

  const hasAutonomy = profile.never_without_asking || profile.autonomy_rules
  if (hasAutonomy) {
    const lines = ['**Autonomy rules:**']
    if (profile.never_without_asking) lines.push(`- Always confirm before: ${profile.never_without_asking}`)
    if (profile.autonomy_rules) lines.push(`- Other rules: ${profile.autonomy_rules}`)
    parts.push(lines.join('\n'))
  }

  const hasDomain = profile.expertise_areas || profile.learning_areas
  if (hasDomain) {
    const lines = ['**Domain knowledge:**']
    if (profile.expertise_areas) lines.push(`- Expert in: ${profile.expertise_areas}`)
    if (profile.learning_areas) lines.push(`- Learning: ${profile.learning_areas}`)
    parts.push(lines.join('\n'))
  }

  return parts.join('\n\n')
}

// ─── File IO ──────────────────────────────────────────────────────────────────

export function saveUserMd(profile?: UserProfile, userId = 'local'): void {
  const p = profile ?? getProfile(userId)
  const content = generateUserMd(p)
  if (!content) return
  fs.mkdirSync(JARVIS_DIR, { recursive: true })
  fs.writeFileSync(USER_MD_PATH, content, 'utf-8')
}

export function loadUserMd(): string | null {
  if (!fs.existsSync(USER_MD_PATH)) return null
  try {
    return fs.readFileSync(USER_MD_PATH, 'utf-8').trim() || null
  } catch {
    return null
  }
}

// ─── Writing samples ──────────────────────────────────────────────────────────

export const SAMPLES_DIR = path.join(JARVIS_DIR, 'samples')

export function saveWritingSample(content: string, sourcePlatform?: string, userId = 'local'): string {
  const id = uuid()
  db.prepare(`
    INSERT INTO writing_samples (id, user_id, content, source_platform)
    VALUES (?, ?, ?, ?)
  `).run(id, userId, content, sourcePlatform ?? null)
  // Mirror to disk so agent can read_file on it in future phases
  fs.mkdirSync(SAMPLES_DIR, { recursive: true })
  fs.writeFileSync(path.join(SAMPLES_DIR, `${id}.txt`), content, 'utf-8')
  return id
}

export function clearWritingSamples(userId = 'local'): void {
  db.prepare('DELETE FROM writing_samples WHERE user_id = ?').run(userId)
}

export function getWritingSamples(userId = 'local'): Array<{ content: string; source_platform: string | null; created_at: string }> {
  return db.prepare('SELECT content, source_platform, created_at FROM writing_samples WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]
}

// ─── Voice extraction ─────────────────────────────────────────────────────────

export async function extractVoiceProfile(samples: string[]): Promise<string> {
  if (samples.length === 0) return ''

  const combined = samples
    .map((s, i) => `[Sample ${i + 1}]\n${s}`)
    .join('\n\n---\n\n')

  try {
    const response = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('low'),
      max_tokens: 150,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `Analyze the writing samples and return a compact voice descriptor in exactly this format (one line each, no elaboration):
Sentences: [very short / short / medium / long]
Vocabulary: [simple / conversational / professional / technical]
Tone: [casual / direct / warm / formal / blunt]
Punctuation: [e.g. "minimal, no semicolons", "frequent em-dashes", "clean and spare"]
Paragraph density: [single sentences / 2-3 lines / longer blocks]
Signature patterns: [1-2 specific patterns — e.g. "starts with a strong claim", "ends with a question", "uses parenthetical asides"]
Avoid: [specific patterns NOT in this person's writing]

Return ONLY these 7 lines. No intro, no explanation.`
        },
        {
          role: 'user',
          content: combined
        }
      ]
    })
    return response.choices[0].message.content?.trim() || ''
  } catch {
    return ''
  }
}
