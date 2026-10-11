import fs from 'fs'
import path from 'path'
import os from 'os'
import { runDeepProfileSetup } from './profile-deep.js'

const ONBOARDED_FLAG = path.join(os.homedir(), '.unclawned', '.onboarded')
const LINE = '─'.repeat(58)

export function isOnboarded(): boolean {
  return fs.existsSync(ONBOARDED_FLAG)
}

function markOnboarded(): void {
  try {
    fs.mkdirSync(path.dirname(ONBOARDED_FLAG), { recursive: true })
    fs.writeFileSync(ONBOARDED_FLAG, new Date().toISOString(), 'utf-8')
  } catch {}
}

async function waitEnter(promptFn: (q: string) => Promise<string>): Promise<boolean> {
  try {
    const input = (await promptFn('  [Press Enter to continue, or type "skip"] ')).trim().toLowerCase()
    return input !== 'skip'
  } catch {
    return false
  }
}

export async function runOnboarding(promptFn: (q: string) => Promise<string>): Promise<void> {
  // ── Screen 1: how tasks work ──────────────────────────────────────────────
  console.log(`\n${LINE}`)
  console.log('  Welcome to OpenClaw')
  console.log(LINE)
  console.log()
  console.log('  Just type what you want. No special syntax needed.')
  console.log()
  console.log('  Examples:')
  console.log('    "Summarize the Notion page I have open"')
  console.log('    "Draft a reply to the last email from Mike"')
  console.log('    "Check my notifications on X and tell me what\'s new"')
  console.log()
  console.log('  The agent uses your Chrome browser — it navigates, clicks,')
  console.log('  fills forms, and reads content on any page you\'re on.')
  console.log()

  const cont1 = await waitEnter(promptFn)
  if (!cont1) { markOnboarded(); console.log('\n  You can run /help anytime to see all commands.\n'); return }

  // ── Screen 2: key commands ────────────────────────────────────────────────
  console.log()
  console.log(LINE)
  console.log('  Useful commands')
  console.log(LINE)
  console.log()
  console.log('  /profile setup        5 questions — tells the AI who you are')
  console.log('  /profile deep_setup   deep context for your role (writer, analyst...)')
  console.log('  /skill                save a task as a reusable shortcut')
  console.log('  /soul setup           set the AI\'s personality and working style')
  console.log('  /help                 see everything')
  console.log()

  const cont2 = await waitEnter(promptFn)
  if (!cont2) { markOnboarded(); console.log('\n  You can run /help anytime to see all commands.\n'); return }

  // ── Screen 3: profile setup prompt ───────────────────────────────────────
  console.log()
  console.log(LINE)
  console.log('  Recommended first step: /profile setup  (~5 min)')
  console.log(LINE)
  console.log()
  console.log('  5 questions about who you are, what you\'re building,')
  console.log('  and how you like things done.')
  console.log()
  console.log('  Every task gets smarter once the AI knows who it\'s working for.')
  console.log()

  let answer: string
  try {
    answer = (await promptFn('  Run /profile setup now? [y / n] > ')).trim().toLowerCase()
  } catch {
    markOnboarded()
    return
  }

  markOnboarded()

  if (answer === 'y' || answer === 'yes') {
    console.log()
    await runDeepProfileSetup(promptFn)
  } else {
    console.log('\n  You can run /profile setup anytime. Let\'s go.\n')
  }
}
