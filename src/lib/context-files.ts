import fs from 'fs'
import path from 'path'
import { resolveRuntime } from './model-router.js'
import { JARVIS_DIR } from './soul.js'
import { db } from './db.js'
import { getProfile } from './user-profile.js'
import { getSectionContent } from './memory.js'

const _rt = () => resolveRuntime()

export const CONTEXT_DIR = path.join(JARVIS_DIR, 'context')
export const TASKS_DIR = path.join(CONTEXT_DIR, 'tasks')
export const ARCHIVE_DIR = path.join(TASKS_DIR, 'archive')

// ─── Directory init ───────────────────────────────────────────────────────────

export function initContextDirs(): void {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true })
  fs.mkdirSync(TASKS_DIR, { recursive: true })
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true })
}

// ─── Platform keyword detection ───────────────────────────────────────────────

const PLATFORM_KEYWORDS: Record<string, string[]> = {
  linkedin:  ['linkedin', 'linked in'],
  twitter:   ['twitter', 'x.com', 'tweet', 'tweets'],
  gmail:     ['gmail', 'email', 'emails', 'inbox'],
  instagram: ['instagram', 'ig ', 'insta'],
  facebook:  ['facebook', ' fb '],
  youtube:   ['youtube', 'yt '],
  reddit:    ['reddit', 'subreddit'],
}

export function detectPlatform(task: string): string | null {
  const taskLower = task.toLowerCase()
  for (const [platform, keywords] of Object.entries(PLATFORM_KEYWORDS)) {
    if (keywords.some(k => taskLower.includes(k))) return platform
  }
  return null
}

// ─── Context file IO ──────────────────────────────────────────────────────────

export function contextFilePath(platform: string): string {
  return path.join(CONTEXT_DIR, `${platform}.md`)
}

export function loadContextFile(platform: string): string | null {
  const filePath = contextFilePath(platform)
  if (!fs.existsSync(filePath)) return null
  try {
    return fs.readFileSync(filePath, 'utf-8').trim() || null
  } catch {
    return null
  }
}

export function saveContextFile(platform: string, content: string): void {
  initContextDirs()
  fs.writeFileSync(contextFilePath(platform), content, 'utf-8')
}

export function listContextFiles(): Array<{ platform: string; chars: number }> {
  initContextDirs()
  try {
    return fs.readdirSync(CONTEXT_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const platform = f.replace('.md', '')
        const content = loadContextFile(platform) ?? ''
        return { platform, chars: content.length }
      })
  } catch {
    return []
  }
}

// ─── Context for task (load if platform detected) ─────────────────────────────

export const CONTEXT_MAX_CHARS = 1600

export function getContextForTask(task: string): { platform: string; content: string } | null {
  const platform = detectPlatform(task)
  if (!platform) return null
  const content = loadContextFile(platform)
  if (!content) return { platform, content: '' }  // platform detected but no file yet
  // Trim if over budget
  const trimmed = content.length > CONTEXT_MAX_CHARS
    ? content.slice(0, CONTEXT_MAX_CHARS) + '\n[...context truncated]'
    : content
  return { platform, content: trimmed }
}

// ─── Platform task count (stored in user_profile) ────────────────────────────

function platformCountKey(platform: string): string {
  return `ctx_count_${platform}`
}

export function incrementPlatformCount(platform: string, userId = 'local'): number {
  const key = platformCountKey(platform)
  const current = db.prepare('SELECT value FROM user_profile WHERE user_id = ? AND key = ?').get(userId, key) as any
  const newCount = ((current?.value ? parseInt(current.value) : 0)) + 1
  db.prepare(`
    INSERT INTO user_profile (user_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, key, String(newCount))
  return newCount
}

export function getPlatformCount(platform: string, userId = 'local'): number {
  const key = platformCountKey(platform)
  const row = db.prepare('SELECT value FROM user_profile WHERE user_id = ? AND key = ?').get(userId, key) as any
  return row?.value ? parseInt(row.value) : 0
}

// Returns true only exactly when count hits 3 (proposal fires once)
export function shouldProposeContextFile(platform: string, userId = 'local'): boolean {
  const count = getPlatformCount(platform, userId)
  return count === 3 && !fs.existsSync(contextFilePath(platform))
}

// ─── Observation sync into context file ──────────────────────────────────────

// After writing a platform observation to MEMORY.md, also append it to the
// platform's context file (if one exists) under "## Observed patterns".
export function appendObservationToContextFile(platform: string, observation: string, date: string): void {
  const content = loadContextFile(platform)
  if (!content) return  // no context file for this platform yet — skip

  const entry = `- ${date}: ${observation}`
  const sectionHeader = '## Observed patterns'

  let updated: string
  if (content.includes(sectionHeader)) {
    // Append inside the existing section
    updated = content.replace(
      new RegExp(`(${sectionHeader}\\n)([\\s\\S]*?)(?=\\n##|$)`),
      (_match, header, body) => `${header}${body.trimEnd()}\n${entry}\n`
    )
  } else {
    updated = `${content.trimEnd()}\n\n${sectionHeader}\n${entry}\n`
  }

  saveContextFile(platform, updated)
}

// ─── LLM context file draft ───────────────────────────────────────────────────

export async function draftContextFile(platform: string, userId = 'local'): Promise<string> {
  const profile = getProfile(userId)
  const platformObservations = getSectionContent('PLATFORM OBSERVATIONS')
  const relevantObservations = platformObservations
    .split('\n')
    .filter(l => l.toLowerCase().includes(platform))
    .join('\n')

  const today = new Date().toISOString().split('T')[0]

  try {
    const response = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('low'),
      max_tokens: 500,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Write a context file for an AI browser agent that operates on ${platform}.
This file will be injected into the agent's system prompt before every ${platform} task.

Return ONLY valid markdown. No code blocks, no preamble. Max 400 words.

Include these sections:
# ${platform.charAt(0).toUpperCase() + platform.slice(1)} — Operational Context
Created: ${today}

## Navigation
[Key URLs for this platform]

## User's approach on this platform
[Based on user profile — how they use this platform, what they post, tone they use]

## Tips for the agent
[2-4 operational tips specific to ${platform} navigation that the agent should remember]

## Observed patterns
[From platform observations below, or "None yet — will fill in as patterns emerge."]`
        },
        {
          role: 'user',
          content: `User profile:
- Role: ${profile.role ?? 'not set'}
- Social platforms: ${profile.social_platforms ?? 'not set'}
- Voice/tone: ${profile.formality ?? 'not set'}

Platform observations from memory:
${relevantObservations || 'None yet.'}

Write the ${platform}.md context file.`
        }
      ]
    })
    return response.choices[0].message.content?.trim() ?? `# ${platform} Context\nCreated: ${today}\n\nNo content yet.`
  } catch {
    return `# ${platform.charAt(0).toUpperCase() + platform.slice(1)} — Operational Context\nCreated: ${today}\n\n## Navigation\n[Fill in key URLs]\n\n## Tips for the agent\n[Fill in operational tips]\n`
  }
}
