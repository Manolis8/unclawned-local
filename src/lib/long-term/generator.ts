import fs from 'fs'
import path from 'path'
import { resolveRuntime } from '../model-router.js'
import { db } from '../db.js'
import { getSectionContent } from '../memory.js'
import { getOpenItems } from '../open-items/tracker.js'
import { getProfile } from '../user-profile.js'

const _rt = () => resolveRuntime()

export const LONG_TERM_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '',
  '.unclawned',
  'USER-LONG-TERM.md'
)

export function loadLongTermMd(): string | null {
  try {
    if (!fs.existsSync(LONG_TERM_PATH)) return null
    return fs.readFileSync(LONG_TERM_PATH, 'utf-8').trim() || null
  } catch { return null }
}

export function saveLongTermMd(content: string): void {
  try {
    fs.mkdirSync(path.dirname(LONG_TERM_PATH), { recursive: true })
    fs.writeFileSync(LONG_TERM_PATH, content, 'utf-8')
  } catch {}
}

function gatherLongTermInputs(userId: string): string {
  const parts: string[] = []

  // Recent PROJECTS diary entries
  const projects = getSectionContent('PROJECTS')
  if (projects.trim()) {
    const lines = projects.trim().split('\n').slice(-10).join('\n')
    parts.push(`[Recent activity from diary]\n${lines}`)
  }

  // Open items
  const openItems = getOpenItems(userId)
  if (openItems.length > 0) {
    const itemLines = openItems
      .slice(0, 8)
      .map(i => `- ${i.summary}${i.related_person ? ` (${i.related_person})` : ''}${i.context ? ` [${i.context}]` : ''}`)
      .join('\n')
    parts.push(`[Open threads — awaiting follow-up]\n${itemLines}`)
  }

  // Channel M vocabulary drift
  try {
    const mProf = db.prepare('SELECT drift_direction, drift_magnitude FROM channel_m_profiles WHERE user_id = ?').get(userId) as any
    if (mProf?.drift_direction) {
      parts.push(`[Vocabulary drift signal]\nCurrent focus has shifted toward: ${mProf.drift_direction} (magnitude: ${mProf.drift_magnitude ?? 'unknown'})`)
    }
  } catch {}

  // Channel O recent achievements
  try {
    const oProf = db.prepare('SELECT most_recent_achievement, most_recent_at, dominant_achievement_type FROM channel_o_profiles WHERE user_id = ?').get(userId) as any
    if (oProf?.most_recent_achievement) {
      parts.push(`[Recent win]\n${oProf.most_recent_achievement} (${oProf.most_recent_at?.split('T')[0] ?? 'recently'})`)
    }
  } catch {}

  // Active relationships from channel_f
  try {
    const people = db.prepare(`
      SELECT person_name, mention_context, context_tone
      FROM channel_f_person_mentions
      WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 5
    `).all(userId) as any[]
    if (people.length > 0) {
      const lines = people.map(p => `- ${p.person_name}: ${p.mention_context ?? 'mentioned recently'}`).join('\n')
      parts.push(`[Recent people in context]\n${lines}`)
    }
  } catch {}

  // User profile for grounding
  const profile = getProfile(userId)
  if (profile.current_goals) {
    parts.push(`[Stated goals from user profile]\n${profile.current_goals}`)
  }

  return parts.join('\n\n')
}

export async function generateAndSaveLongTermMd(userId: string): Promise<void> {
  const inputs = gatherLongTermInputs(userId)
  if (!inputs.trim()) return

  const today = new Date().toISOString().split('T')[0]

  try {
    const response = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('low'),
      max_tokens: 600,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Write a "what's happening right now" document for a personal AI agent. This document helps the agent understand what the user is actively working on, what matters to them right now, and what they might need continuity on across sessions.

Write in second-person ("You've been..."). Use plain markdown with simple headers. Max 500 words. Be specific — no generic filler. Base everything only on the data provided.

Sections to include (only if data supports them):
## Active focus
What the user has been spending energy on lately (from vocabulary drift, diary entries, goals)

## Open threads
Things that were started and need a follow-up (from open_items). Phrase as: "X days ago: [what happened] — [person/context]"

## Key people right now
Who has been showing up in conversations lately

## Recent win
If there's a recent achievement, mention it briefly — keep it energizing

## What went quiet (optional)
Only if there's a clear signal of a topic that was prominent and then dropped off

End with a single italicized line: *Updated ${today}*

Return ONLY the markdown content. No code blocks, no preamble.`
        },
        {
          role: 'user',
          content: inputs
        }
      ]
    })

    const content = response.choices[0].message.content?.trim()
    if (content) {
      saveLongTermMd(content)
      // Record generation timestamp
      db.prepare(`
        INSERT INTO user_profile (user_id, key, value, updated_at)
        VALUES (?, 'long_term_updated_at', ?, datetime('now'))
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(userId, new Date().toISOString())
    }
  } catch {}
}
