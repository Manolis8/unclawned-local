import { execSync } from 'child_process'
import fs from 'fs'
import {
  getProfile, setProfileFields, setProfileField,
  saveUserMd, generateUserMd, loadUserMd, isProfileEmpty, isProfileUsable,
  USER_MD_PATH, type UserProfile, type ProfileKey,
  saveWritingSample, clearWritingSamples, extractVoiceProfile,
} from './user-profile.js'
import { runDeepProfileSetup, isDeepProfile, patchGoalsInDeepProfile } from './profile-deep.js'

type PromptFn = (question: string) => Promise<string>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function header(text: string) {
  const line = '─'.repeat(55)
  console.log(`\n${line}`)
  console.log(`  ${text}`)
  console.log(line)
}

function tip(text: string) {
  console.log(`  (${text})`)
}

async function ask(promptFn: PromptFn, question: string, current?: string): Promise<string> {
  const hint = current ? ` [current: ${current}]` : ''
  const answer = (await promptFn(`  ${question}${hint}: `)).trim()
  return answer
}

async function askOptional(promptFn: PromptFn, question: string, current?: string): Promise<string> {
  const hint = current ? ` [current: ${current}]` : ' [optional — press Enter to skip]'
  return (await promptFn(`  ${question}${hint}: `)).trim()
}

// ─── /profile setup ───────────────────────────────────────────────────────────

export async function runProfileSetup(promptFn: PromptFn): Promise<void> {
  return runDeepProfileSetup(promptFn)
}

/** @deprecated Legacy linear wizard — kept for reference only, not called from anywhere. */
async function _legacyProfileSetup(promptFn: PromptFn): Promise<void> {
  const existing = getProfile()
  const isResume = isProfileUsable()

  header('Jarvis Profile Setup')
  if (isResume) {
    console.log('  Resuming your existing profile. Press Enter to keep current values.\n')
  } else {
    console.log('  This takes ~10 minutes. Every answer makes every task smarter.')
    console.log('  Press Enter to skip any optional field and fill it in later.\n')
  }

  // ── Step 1: Identity ──────────────────────────────────────────────────────
  header('Step 1 / 6 — Identity')

  const name = await ask(promptFn, 'Your first name', existing.name)
  const role = await ask(promptFn, 'Your role (e.g. founder, CEO, developer, freelancer)', existing.role)
  const company_name = await askOptional(promptFn, 'Company or project name', existing.company_name)
  const company_description = company_name
    ? await askOptional(promptFn, 'What does it do? (one sentence)', existing.company_description)
    : ''
  const target_customer = await askOptional(promptFn, 'Who do you sell to / build for?', existing.target_customer)

  setProfileFields({ name, role, company_name, company_description, target_customer })
  console.log('  ✓ Identity saved.\n')

  // ── Step 2: Writing samples + voice extraction ────────────────────────────
  header('Step 2 / 6 — Your writing voice')
  tip('Paste 1-3 real messages you\'ve written (emails, posts, DMs — anything)')
  console.log('  Jarvis will analyze them and extract your voice automatically.')
  console.log('  More samples = better extraction. You can skip with Enter.\n')

  const samples: string[] = []
  for (let i = 1; i <= 3; i++) {
    console.log(`  Sample ${i} of 3${i > 1 ? ' (optional)' : ''}:`)
    console.log('  Paste your text, then type --- on a new line and press Enter.')
    console.log('  Or press Enter immediately to skip.')

    const lines: string[] = []
    let firstLine = true
    while (true) {
      const line = await promptFn('')
      if (firstLine && line.trim() === '') {
        // Empty first line = skip this sample
        break
      }
      firstLine = false
      if (line.trim() === '---') break
      lines.push(line)
      if (lines.length >= 200) break
    }
    const sample = lines.join('\n').trim()
    if (sample) {
      samples.push(sample)
      console.log(`  ✓ Sample ${i} captured (${sample.split(/\s+/).length} words)\n`)
    } else {
      break
    }
  }

  let voice_profile = existing.voice_profile || ''
  if (samples.length > 0) {
    console.log('  Analyzing your voice...')
    try {
      const extracted = await extractVoiceProfile(samples)
      if (extracted) {
        voice_profile = extracted
        console.log('\n  Extracted voice profile:')
        console.log(extracted.split('\n').map((l: string) => '  ' + l).join('\n'))
        const confirm = (await promptFn('\n  Use this? (y/n) > ')).trim().toLowerCase()
        if (confirm !== 'y' && confirm !== 'yes') {
          voice_profile = existing.voice_profile || ''
          console.log('  Voice profile extraction skipped.\n')
        } else {
          // Save samples to DB
          clearWritingSamples()
          const platform = (await promptFn('  Platform for these samples? (e.g. LinkedIn, email, Twitter) > ')).trim()
          for (const s of samples) saveWritingSample(s, platform || undefined)
          console.log('  ✓ Voice profile and samples saved.\n')
        }
      }
    } catch {
      console.log('  Voice extraction failed — profile not updated.\n')
    }
  } else {
    console.log('  No samples provided. Using existing voice profile or manual description.\n')
  }

  console.log('  Now the basic style settings:')
  console.log()
  console.log('  Tone options: casual / professional / depends on platform')
  const formality = await ask(promptFn, 'Your default tone', existing.formality)

  console.log()
  console.log('  Emoji options: yes / no / context-dependent')
  const emoji_usage = await ask(promptFn, 'Do you use emojis in professional contexts?', existing.emoji_usage)

  console.log()
  console.log('  Length options: short and direct / medium / detailed')
  const message_length = await ask(promptFn, 'Typical message length', existing.message_length)

  setProfileFields({ voice_profile, formality, emoji_usage, message_length })
  console.log('  ✓ Communication style saved.\n')

  // ── Step 3: Banned phrases ────────────────────────────────────────────────
  header('Step 3 / 6 — Words & phrases you hate')
  tip('comma-separated. Example: synergy, leverage, circle back, reach out, touch base')
  console.log()

  const banned_phrases = await askOptional(
    promptFn,
    'Words or phrases you NEVER want me to use',
    existing.banned_phrases
  )
  const natural_phrases = await askOptional(
    promptFn,
    'Phrases you naturally use that I should adopt',
    existing.natural_phrases
  )

  setProfileFields({ banned_phrases, natural_phrases })
  console.log('  ✓ Phrase preferences saved.\n')

  // ── Step 4: Platforms & tools ─────────────────────────────────────────────
  header('Step 4 / 6 — Platforms & tools')

  const email_client = await ask(promptFn, 'Email client (Gmail / Outlook / Apple Mail)', existing.email_client)
  const social_platforms = await askOptional(
    promptFn,
    'Social platforms you use (e.g. LinkedIn, Twitter/X, Instagram)',
    existing.social_platforms
  )
  const crm_tool = await askOptional(promptFn, 'CRM tool (e.g. HubSpot, Notion, none)', existing.crm_tool)
  const notes_tool = await askOptional(promptFn, 'Notes / docs tool (e.g. Notion, Obsidian, Google Docs)', existing.notes_tool)
  const important_folders = await askOptional(
    promptFn,
    'Key folder paths (e.g. Desktop, Documents/Projects)',
    existing.important_folders
  )

  setProfileFields({ email_client, social_platforms, crm_tool, notes_tool, important_folders })
  console.log('  ✓ Platforms saved.\n')

  // ── Step 5: Goals ─────────────────────────────────────────────────────────
  header('Step 5 / 6 — Current goals')
  tip('These go stale — you\'ll get a nudge to update them every 2 weeks')
  console.log()

  const current_goals = await ask(
    promptFn,
    'What are you working on right now? (1-3 sentences)',
    existing.current_goals
  )
  const success_metric = await askOptional(
    promptFn,
    'What does winning look like this month?',
    existing.success_metric
  )
  const automate_most = await askOptional(
    promptFn,
    'What tasks do you want me to handle automatically the most?',
    existing.automate_most
  )

  const goalsUpdatedAt = new Date().toISOString().split('T')[0]
  setProfileFields({ current_goals, success_metric, automate_most, goals_updated_at: goalsUpdatedAt })
  console.log('  ✓ Goals saved.\n')

  // ── Step 6: Autonomy ──────────────────────────────────────────────────────
  header('Step 6 / 6 — What requires your approval')
  tip('e.g. "always show me emails before sending", "never post publicly without confirming"')
  console.log()

  const never_without_asking = await askOptional(
    promptFn,
    'What should I NEVER do without asking you first?',
    existing.never_without_asking
  )
  const autonomy_rules = await askOptional(
    promptFn,
    'Any other hard rules? (e.g. always CC a specific person)',
    existing.autonomy_rules
  )

  setProfileFields({ never_without_asking, autonomy_rules })
  console.log('  ✓ Autonomy rules saved.\n')

  // ── Write USER.md ─────────────────────────────────────────────────────────
  const fullProfile = getProfile()
  saveUserMd(fullProfile)

  const line = '─'.repeat(55)
  console.log(`\n${line}`)
  console.log('  ✅ Profile complete. Saved to USER.md.')
  console.log(`  Every task from now on knows who it\'s working for.`)
  console.log(`  To review: /profile show`)
  console.log(`  To update a section: /profile update goals`)
  console.log(line + '\n')
}

// ─── /profile show ────────────────────────────────────────────────────────────

export function showProfile(): void {
  // Read directly from file — file is the source of truth for the agent,
  // so /profile show reflects exactly what the agent sees.
  const content = loadUserMd()
  const line = '─'.repeat(55)

  if (!content) {
    console.log('\n  No profile set up yet. Run /profile setup to get started.\n')
    return
  }

  console.log(`\n${line}`)
  console.log('  YOUR PROFILE  (USER.md)')
  console.log(line)
  console.log()
  console.log(content.split('\n').map(l => '  ' + l).join('\n'))
  console.log()
  console.log(`  File: ${USER_MD_PATH}`)
  console.log(`  Edit directly: /profile edit`)
  console.log(`  Update a section: /profile update goals`)
  console.log(line + '\n')
}

// ─── /profile edit ────────────────────────────────────────────────────────────

export function openProfileInEditor(): void {
  if (!fs.existsSync(USER_MD_PATH)) {
    console.log('\n  No profile file yet. Run /profile setup first.\n')
    return
  }
  try {
    // Opens in the default system editor (notepad on Windows, $EDITOR on Unix)
    if (process.platform === 'win32') {
      execSync(`start notepad "${USER_MD_PATH}"`, { stdio: 'ignore' })
    } else {
      const editor = process.env.EDITOR || 'nano'
      execSync(`${editor} "${USER_MD_PATH}"`)
    }
    console.log(`\n  Opened USER.md in editor. Changes take effect on the next task.\n`)
  } catch {
    console.log(`\n  Could not open editor automatically.`)
    console.log(`  Edit the file directly at:\n  ${USER_MD_PATH}\n`)
  }
}

// ─── /profile update <section> ────────────────────────────────────────────────

const SECTION_MAP: Record<string, { label: string; fields: ProfileKey[] }> = {
  identity:   { label: 'Identity',             fields: ['name', 'role', 'company_name', 'company_description', 'target_customer'] },
  voice:      { label: 'Communication style',  fields: ['voice_profile', 'formality', 'emoji_usage', 'message_length', 'banned_phrases', 'natural_phrases'] },
  platforms:  { label: 'Platforms & tools',    fields: ['email_client', 'social_platforms', 'crm_tool', 'notes_tool', 'important_folders'] },
  goals:      { label: 'Current goals',        fields: ['current_goals', 'success_metric', 'automate_most'] },
  autonomy:   { label: 'Autonomy rules',       fields: ['never_without_asking', 'autonomy_rules'] },
  domain:     { label: 'Domain knowledge',     fields: ['expertise_areas', 'learning_areas'] },
}

const FIELD_QUESTIONS: Record<ProfileKey, string> = {
  name:                 'Your first name',
  role:                 'Your role',
  company_name:         'Company or project name',
  company_description:  'What it does (one sentence)',
  target_customer:      'Who you sell to / build for',
  voice_profile:        'Your writing style (1-2 sentences)',
  formality:            'Default tone (casual / professional / depends)',
  emoji_usage:          'Emoji usage (yes / no / context-dependent)',
  message_length:       'Message length (short / medium / detailed)',
  banned_phrases:       'Words/phrases to NEVER use (comma-separated)',
  natural_phrases:      'Phrases you naturally use',
  email_client:         'Email client',
  social_platforms:     'Social platforms you use',
  crm_tool:             'CRM tool',
  notes_tool:           'Notes / docs tool',
  important_folders:    'Key folder paths',
  current_goals:        'What are you working on right now?',
  success_metric:       'What does winning look like this month?',
  automate_most:        'What tasks do you most want automated?',
  goals_updated_at:     '', // internal, never shown
  never_without_asking: 'What should I NEVER do without asking first?',
  autonomy_rules:       'Any other hard rules?',
  expertise_areas:      'Areas of deep expertise',
  learning_areas:       'Areas still being learned',
  write_approval:       '', // internal setting, not shown in guided setup
}

// Re-run writing sample collection + voice extraction for /profile update voice
async function updateVoiceWithSamples(promptFn: PromptFn): Promise<void> {
  header('Update: Voice (writing samples)')
  console.log('  Paste 1-3 writing samples. Existing samples will be replaced.\n')

  const samples: string[] = []
  for (let i = 1; i <= 3; i++) {
    console.log(`  Sample ${i} of 3${i > 1 ? ' (optional)' : ''}:`)
    console.log('  Paste text, then type --- on a new line. Press Enter immediately to skip.')
    const lines: string[] = []
    let firstLine = true
    while (true) {
      const line = await promptFn('')
      if (firstLine && line.trim() === '') break
      firstLine = false
      if (line.trim() === '---') break
      lines.push(line)
      if (lines.length >= 200) break
    }
    const sample = lines.join('\n').trim()
    if (sample) {
      samples.push(sample)
      console.log(`  ✓ Sample ${i} captured\n`)
    } else {
      break
    }
  }

  if (samples.length === 0) {
    console.log('\n  No samples provided. Voice profile not updated.\n')
    return
  }

  console.log('  Analyzing...')
  const extracted = await extractVoiceProfile(samples).catch(() => '')
  if (!extracted) {
    console.log('  Extraction failed.\n')
    return
  }

  console.log('\n  Extracted voice profile:')
  console.log(extracted.split('\n').map((l: string) => '  ' + l).join('\n'))
  const confirm = (await promptFn('\n  Save this? (y/n) > ')).trim().toLowerCase()
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('  Cancelled.\n')
    return
  }

  clearWritingSamples()
  const platform = (await promptFn('  Platform for these samples? (e.g. LinkedIn, email) > ')).trim()
  for (const s of samples) saveWritingSample(s, platform || undefined)
  setProfileFields({ voice_profile: extracted })
  saveUserMd()
  console.log('\n  ✓ Voice profile and samples updated. USER.md regenerated.\n')
}

export async function updateProfileSection(section: string, promptFn: PromptFn): Promise<void> {
  const sectionKey = section.toLowerCase()

  // Deep profiles need section-aware patching, not DB-field regeneration.
  if (isDeepProfile()) {
    if (sectionKey === 'goals') {
      await patchGoalsInDeepProfile(promptFn)
      return
    }
    console.log('\n  You have a deep profile — individual section updates aren\'t supported.')
    console.log('  Quick edit:    /profile edit  (opens USER.md directly)')
    console.log('  Full refresh:  /profile setup  (short session, ~10 min)\n')
    return
  }

  // Special case: /profile update voice → re-run sample extraction
  if (sectionKey === 'voice') {
    await updateVoiceWithSamples(promptFn)
    return
  }

  const def = SECTION_MAP[sectionKey]

  if (!def) {
    const available = Object.keys(SECTION_MAP).join(', ')
    console.log(`\n  Unknown section "${section}". Available: ${available}\n`)
    return
  }

  const existing = getProfile()
  header(`Update: ${def.label}`)
  console.log('  Press Enter to keep the current value.\n')

  const updates: Partial<UserProfile> = {}
  for (const field of def.fields) {
    const question = FIELD_QUESTIONS[field]
    if (!question) continue
    const current = existing[field]
    const answer = await askOptional(promptFn, question, current)
    if (answer) updates[field] = answer
  }

  // Stamp goals_updated_at whenever goals are updated
  if (sectionKey === 'goals' && Object.keys(updates).length > 0) {
    updates.goals_updated_at = new Date().toISOString().split('T')[0]
  }

  if (Object.keys(updates).length === 0) {
    console.log('\n  No changes made.\n')
    return
  }

  setProfileFields(updates)
  saveUserMd()

  console.log(`\n  ✓ ${def.label} updated. USER.md regenerated.\n`)
}
