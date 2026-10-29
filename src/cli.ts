import { createServer } from 'http'
import readline from 'node:readline'
import fs from 'fs'
import { spawn, execFileSync } from 'child_process'
import { findChromeExecutableWindows, findChromeExecutableMac, findChromeExecutableLinux } from './browser/chrome.executables.js'
import { orchestrateTask } from './lib/agents/orchestrator.js'
import { runAgentWithExtension, closeAllBrowserConnections, getOpenTabs, getLastUsedTab, wasLastAgentRunSuccessful, getStandingPermissionSuggestion, clearStandingPermissionSuggestion } from './lib/agent-extension.js'
import { handleConfirmationRequest } from './lib/cli-confirmation.js'
import { executeHybridTask } from './lib/hybrid-executor.js'
import { extensionConnections } from './lib/extension-state.js'
import { startExtensionWsServer } from './lib/extension-ws-server.js'
import { runTaskInBackground } from './routes/tasks.js'
import { runSetupIfNeeded, runSetupWizard, runSetupApiKeys } from './setup.js'
import { db } from './lib/db.js'
import { WebSocket } from 'ws'
import { runSkillCreator, listSkills, runSavedSkill, runSkillEditor, collectRuntimeVars, prefillVarsFromTask, runSkillDelete, showDrafts, showProposals, pinSkill, unpinSkill, restoreArchivedSkill, getSkillInboxCount, showSkillCard, buildSkillEnrichedTask } from './lib/cli-skill-creator.js'
import { findSkillBySlug } from './db/queries.js'
import { runProfileSetup, showProfile, updateProfileSection, openProfileInEditor } from './lib/profile-command.js'
import { runDeepRoleSetup } from './lib/profile-deep-role.js'
import { isOnboarded, runOnboarding } from './lib/onboarding.js'
import { isProfileEmpty, getGoalsFreshness } from './lib/user-profile.js'
import { maybeSurfaceProfileQuestion } from './lib/profile-lazy.js'
import { runSoulSetup, showSoul, openSoulInEditor } from './lib/soul-command.js'
import { runBackgroundReview, archiveSession, getPendingCount, getPendingMemory, approvePendingEntry, dismissPendingEntry, searchSessions } from './lib/memory-review.js'
import { loadMemoryMd, getMemoryStats, getCapacityPercent, MEMORY_MAX_CHARS, initMemoryMd, getKnownPeople, findKnownPersonInTask } from './lib/memory.js'
import { initContextDirs, listContextFiles, loadContextFile, saveContextFile, detectPlatform, incrementPlatformCount, shouldProposeContextFile, draftContextFile, contextFilePath } from './lib/context-files.js'
import { createTaskMd, archiveTaskMd, listActiveTasks, cleanStaleTasks } from './lib/task-md.js'
import { initSuggestionsMd, loadSuggestions, loadArchivedSuggestions, dismissSuggestion, getPendingSuggestionCount } from './lib/suggestions.js'
import { searchSkillsForTask, buildAttachedSkillsContext, resolveSkillByName, getRecentGapEvents, checkGapProposals, getAttachedSkillVariables } from './lib/skill-index.js'
import { ConversationalState, extractEntities, resolveReferences, buildContinuationContext } from './lib/conversation-state.js'
import { acquireCliLock, isCliLockHeldByThisProcess } from './lib/process-lock.js'
import { getOpenItems, getOverdueOpenItems, getTopOverdueItem, resolveItem, resolveByKeyword, dismissItem, daysSince } from './lib/open-items/tracker.js'
import { resolveRuntime, invalidateRuntime } from './lib/model-router.js'
import { generateInsightQuestion } from './lib/action-engine/insight-judge.js'
import { handleMissionsCommand, checkMissionMode } from './lib/cli-missions.js'

const PLATFORM_NAMES: Record<string, string> = {
  linkedin: 'LinkedIn', twitter: 'Twitter', instagram: 'Instagram',
  facebook: 'Facebook', 'x.com': 'X'
}

async function extractPostContent(chatResponse: string): Promise<string> {
  try {
    const rt = resolveRuntime()
    const res = await rt.fastClient.chat.completions.create({
      model: rt.modelFor('low'),
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'Extract only the social media post content from this text. Return ONLY the post body — remove any intro phrase ("Here is your post:", "Sure! Here\'s a suggestion:", "Absolutely!"), any sign-off ("Feel free to tweak it"), and any meta-commentary. Return just the post text, exactly as written.' },
        { role: 'user', content: chatResponse }
      ]
    })
    return res.choices[0].message.content?.trim() || chatResponse
  } catch {
    return chatResponse
  }
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (recovered):', err.message)
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  if (msg.includes('Duplicate target') || msg.includes('Session with given id not found') || msg.includes('Target closed') || msg.includes('Browser has been closed')) {
    // These are Playwright CDP lifecycle errors. The target/page is already registered or
    // the session is being torn down — Playwright can still operate. Do NOT reset or close
    // the browser connection here: doing so triggers browser.close() which cascades into
    // the extension closing Chrome, which kills the relay and exits the process.
    console.error('Unhandled rejection (recovered):', msg)
    return
  }
  console.error('Unhandled rejection (recovered):', reason)
})

// ── Global shutdown ───────────────────────────────────────────────────────────

const activeAgents = new Set<AbortController>()
let shuttingDown = false
let _currentCliSessionId: string | undefined
let _sessionResumeContext: string | undefined
let _sessionTaskCount = 0
let _resumedFromSessionId: string | undefined
// Categories where user ignored twice in this session — don't surface again
const _sessionSkippedInsightCategories = new Set<string>()
let _resumedSessionTitle: string | undefined
// Ordered (user, assistant) pairs accumulated during this jarvis run — Hermes-style history
let _sessionMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
// Channel A-O context cached at first chat call — Hermes NODE 8: system prompt built once per session
let _cachedChannelContext: string | undefined

async function shutdown(reason = 'Interrupted') {
  if (shuttingDown) return
  shuttingDown = true

  if (_currentCliSessionId) {
    try {
      const { closeCliSession } = await import('./lib/session-manager.js')
      closeCliSession(_currentCliSessionId)
    } catch {}
  }

  // Abort every running agent loop
  for (const ctrl of activeAgents) {
    try { ctrl.abort() } catch {}
  }

  // Disconnect Playwright from Chrome — removes the "unclawned debugging" banner
  await closeAllBrowserConnections().catch(() => {})

  // Mark any DB tasks still marked running as failed
  try {
    db.prepare(`UPDATE tasks SET status = 'error', error = ? WHERE status = 'running'`).run(reason)
  } catch {}

  // Close with code 1001 — extension detects this and detaches all debugger sessions (removes the banner)
  try {
    for (const [, ws] of extensionConnections) {
      try { ws.close(1001, 'Server shutting down') } catch {}
    }
  } catch {}

  console.log('\nGoodbye!')
  process.exit(0)
}

// Double Ctrl+C within 3 seconds to exit — single press shows a hint instead.
// _sigintAt deduplicates: readline (idle) and process-level (mid-task) can both fire
// for the same keypress; the 50ms window ensures only the first one acts.
let _lastSigint = 0
let _sigintAt = 0
function _handleSigint() {
  const now = Date.now()
  if (now - _sigintAt < 50) return  // same keypress already handled
  _sigintAt = now
  if (now - _lastSigint < 3000) {
    shutdown('SIGINT').catch(() => process.exit(0))
  } else {
    _lastSigint = now
    process.stderr.write('\n  Press Ctrl+C again within 3 seconds to exit.\n\n')
  }
}
process.on('SIGINT', _handleSigint)
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)) })

const CLI_PORT = parseInt(process.env.CLI_PORT || '3001')
const _startTime = Date.now()

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } else if (req.url === '/status') {
    const connectedUser = getConnectedUserId()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      uptime_ms: Date.now() - _startTime,
      extension_connected: connectedUser !== null,
      user_id: connectedUser,
    }))
  } else {
    res.writeHead(404)
    res.end()
  }
})

async function drainQueueForUser(userId: string) {
  const queued = db.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'queued' ORDER BY created_at ASC").all(userId) as any[]
  for (const task of queued) {
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id)
    runTaskInBackground(task.id, task.prompt, userId).catch(() => {})
  }
}

startExtensionWsServer(server, drainQueueForUser)

// server.on('error') and server.listen() are called inside main()
// so that `jarvis status` can exit before the server tries to bind.

function getConnectedUserId(): string | null {
  for (const [userId, ws] of extensionConnections) {
    if (ws.readyState === WebSocket.OPEN) return userId
  }
  return null
}

const EXTENSION_URL = 'https://github.com/Manolis8/felo-extension  (load it unpacked, see the README)'

// ── Chrome process detection + launch ─────────────────────────────────────────

function isChromeProcessRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 3000 })
      const lower = out.toLowerCase()
      return lower.includes('chrome.exe') || lower.includes('brave.exe') || lower.includes('msedge.exe') || lower.includes('chromium.exe')
    } else {
      // macOS / Linux
      const out = execFileSync('pgrep', ['-il', 'chrome|brave|chromium|msedge'], { encoding: 'utf8', timeout: 2000 })
      return out.trim().length > 0
    }
  } catch {
    return false
  }
}

function launchChrome(): boolean {
  let exe: { path: string } | null = null
  if (process.platform === 'win32') exe = findChromeExecutableWindows()
  else if (process.platform === 'darwin') exe = findChromeExecutableMac()
  else exe = findChromeExecutableLinux()

  if (!exe) return false

  try {
    spawn(exe.path, [], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

async function ensureConnected(promptFn: (q: string) => Promise<string>): Promise<string | null> {
  const existing = getConnectedUserId()
  if (existing) return existing

  if (isChromeProcessRunning()) {
    console.log('\n⚠️  Chrome extension disconnected.')
    console.log('   Make sure the Unclawned extension is active in Chrome, then try again.\n')
    return null
  }

  // Chrome closed mid-session
  console.log('\n  Chrome closed — the extension needs it to connect.')
  let answer: string
  try {
    answer = (await promptFn('  Open Chrome? [y / n] > ')).trim().toLowerCase()
  } catch { return null }

  if (answer !== 'y' && answer !== 'yes') {
    console.log('  Task cancelled.\n')
    return null
  }

  const launched = launchChrome()
  console.log(launched ? '  Opening Chrome...\n' : '  Open Chrome manually — waiting for extension.\n')

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const userId = getConnectedUserId()
    if (userId) { console.log('  ✓ Extension reconnected.\n'); return userId }
    if (i === 10) console.log('  Still waiting for extension...')
  }

  console.log('  Extension didn\'t reconnect in time. Try again once Chrome is open.\n')
  return null
}

async function checkChromeOrExit(promptFn: (q: string) => Promise<string>): Promise<boolean> {
  // Fast path: extension already connected
  if (getConnectedUserId()) return true

  if (isChromeProcessRunning()) return true

  // Chrome isn't running — ask user
  const LINE = '─'.repeat(60)
  console.log(`\n${LINE}`)
  console.log('  Chrome isn\'t open.')
  console.log('  The Unclawned extension needs Chrome running to connect.')
  console.log(LINE)

  let answer: string
  try {
    answer = (await promptFn('\n  Open Chrome now? [y / n] > ')).trim().toLowerCase()
  } catch { return false }

  if (answer !== 'y' && answer !== 'yes') {
    console.log('\n  Okay — open Chrome and run again whenever you\'re ready.\n')
    return false
  }

  const launched = launchChrome()
  if (launched) {
    console.log('\n  Opening Chrome... waiting for extension to connect.\n')
    await new Promise(r => setTimeout(r, 2500))
  } else {
    console.log('\n  Couldn\'t find Chrome automatically — open it manually.')
    console.log('  Waiting for extension to connect...\n')
  }

  return true
}

async function waitForExtension(): Promise<string> {
  // Fast path: extension already connected (Chrome was already open)
  const immediate = getConnectedUserId()
  if (immediate) return immediate

  // Show setup instructions
  const line = '─'.repeat(60)
  console.log('')
  console.log(line)
  console.log('  jarvis needs the Unclawned Chrome extension to work.')
  console.log(line)
  console.log('')
  console.log('  1. Install the extension:')
  console.log('')
  console.log('     ' + EXTENSION_URL)
  console.log('')
  console.log('  2. Open Chrome')
  console.log('  3. Come back — it connects automatically')
  console.log('')
  console.log(line)
  console.log('  Waiting for extension to connect...')
  console.log(line)
  console.log('')

  let seconds = 0
  while (true) {
    await new Promise(r => setTimeout(r, 1000))
    seconds++

    const userId = getConnectedUserId()
    if (userId) return userId

    if (seconds % 60 === 0) {
      console.log(`  Still waiting (${Math.round(seconds / 60)}m)... Open Chrome with the extension enabled.`)
      console.log(`  ${EXTENSION_URL}`)
    }
  }
}

// Global line buffer — attached to `rl` once in main() via rl.on('line', _dispatchLine).
// All readline 'line' events go here immediately (including paste bursts that fire via
// process.nextTick before any awaited continuation runs). Both `prompt` and `peekLine`
// drain this buffer so they never miss pasted lines.
const _lineQueue: string[] = []
const _lineWaiters: Array<(line: string) => void> = []

export function _dispatchLine(line: string) {
  if (_lineWaiters.length > 0) _lineWaiters.shift()!(line)
  else _lineQueue.push(line)
}

// Drop-in replacement for rl.question — writes prompt directly and reads from buffer.
async function prompt(_rl: readline.Interface, question: string): Promise<string> {
  process.stdout.write(question)
  if (_lineQueue.length > 0) return _lineQueue.shift()!
  return new Promise(resolve => _lineWaiters.push(resolve))
}

// Returns the next line from the buffer immediately, or waits up to timeoutMs.
// Pasted lines are already in the buffer by the time this is called.
function peekLine(_rl: readline.Interface, timeoutMs: number): Promise<string | null> {
  if (_lineQueue.length > 0) return Promise.resolve(_lineQueue.shift()!)
  return new Promise(resolve => {
    const handler = (line: string) => { clearTimeout(timer); resolve(line) }
    const timer = setTimeout(() => {
      const i = _lineWaiters.indexOf(handler)
      if (i >= 0) _lineWaiters.splice(i, 1)
      resolve(null)
    }, timeoutMs)
    _lineWaiters.push(handler)
  })
}

async function maybeShowStandingPermissionSuggestion(rl: readline.Interface): Promise<void> {
  const spSuggestion = getStandingPermissionSuggestion()
  if (!spSuggestion) return
  clearStandingPermissionSuggestion()
  const platLabel = spSuggestion.platform ? ` on ${spSuggestion.platform}` : ''
  console.log(`\n💡 You've approved "${spSuggestion.action_type}"${platLabel} 3 times in a row.`)
  const spAnswer = (await prompt(rl, `   Auto-approve future "${spSuggestion.action_type}"${platLabel} without confirmation? (y/n) > `)).trim().toLowerCase()
  if (spAnswer === 'y' || spAnswer === 'yes') {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const scopeNote = `${spSuggestion.action_type}${platLabel} (auto-approved)`
    const { randomUUID: spUUID } = await import('crypto')
    db.prepare("INSERT INTO standing_permissions (id, user_id, action_type, platform, scope_note, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(spUUID(), spSuggestion.userId, spSuggestion.action_type, spSuggestion.platform || null, scopeNote, expiresAt)
    console.log(`   ✓ Auto-approval set (expires ${expiresAt}). Use /permissions to manage.\n`)
  } else {
    console.log()
  }
}

async function maybeOfferSkillCreation(rl: readline.Interface, userId: string, originalTask: string): Promise<void> {
  console.log(`💡 Want to create a skill so the AI handles this better next time? (y/n)`)
  console.log(`   Task: "${originalTask.slice(0, 120)}"`)
  const answer = (await prompt(rl, '> ')).trim().toLowerCase()
  if (answer === 'y' || answer === 'yes') {
    await runSkillCreator(rl, userId, originalTask)
  }
}

async function main() {
  // `jarvis status` — probe the running instance and exit, no lock or server needed
  if (process.argv[2] === 'status') {
    const { showStatus } = await import('./lib/status.js')
    await showStatus(CLI_PORT)
    process.exit(0)
  }

  // `jarvis setup` — force the setup wizard even if keys already exist
  if (process.argv[2] === 'setup') {
    await runSetupWizard()
    process.exit(0)
  }

  // `jarvis set_api` — add/update API keys without repeating the whole wizard
  if (process.argv[2] === 'set_api') {
    await runSetupApiKeys()
    process.exit(0)
  }

  // `jarvis models` — interactively view/edit model tier assignments
  if (process.argv[2] === 'models') {
    const { runModelsCommand } = await import('./lib/cli-model-config.js')
    await runModelsCommand()
    process.exit(0)
  }

  // `jarvis config <sub> <key> <value>` — configure without starting the server
  if (process.argv[2] === 'config') {
    const { handleConfigCommand } = await import('./lib/user-config.js')
    handleConfigCommand(process.argv.slice(3).join(' '))
    process.exit(0)
  }

  // `jarvis session_list` — browse past sessions, pick one to resume immediately
  if (process.argv[2] === 'session_list') {
    const { showSessionPicker, saveResumeIntent } = await import('./lib/session-manager.js')
    const showAll = process.argv[3] === '--all'
    const pickedId = await showSessionPicker(process.cwd(), showAll)
    if (pickedId) {
      saveResumeIntent(pickedId)
      const { spawn } = await import('child_process')
      spawn(process.argv[0], [process.argv[1]], { stdio: 'inherit', env: process.env }).unref()
    }
    process.exit(0)
  }

  // `jarvis resume` — resume a queued session (from session_list) or the last session from this folder
  if (process.argv[2] === 'resume') {
    const { loadAndClearResumeIntent, getCliSessionById, getLastCliSession, buildSessionContext } = await import('./lib/session-manager.js')
    const intentId = loadAndClearResumeIntent()
    const session = intentId
      ? getCliSessionById(intentId)
      : getLastCliSession('local', process.cwd())
    if (!session) {
      console.log('\n  No previous session found for this folder.')
      console.log('  Run  jarvis  to start your first session.\n')
      process.exit(0)
    }
    _sessionResumeContext = buildSessionContext(session.id)
    _resumedFromSessionId = session.id
    _resumedSessionTitle = session.title || `session from ${session.started_at.slice(0, 10)}`
    // Fall through to full jarvis startup with this session pre-loaded
  }

  // Check if session_list saved a resume intent for normal `jarvis` startup
  if (!process.argv[2]) {
    const { loadAndClearResumeIntent, getCliSessionById, buildSessionContext } = await import('./lib/session-manager.js')
    const intentId = loadAndClearResumeIntent()
    if (intentId) {
      const session = getCliSessionById(intentId)
      if (session) {
        _sessionResumeContext = buildSessionContext(session.id)
        _resumedFromSessionId = session.id
        _resumedSessionTitle = session.title || `session from ${session.started_at.slice(0, 10)}`
      }
    }
  }

  acquireCliLock()

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nError: port ${CLI_PORT} is already in use.`)
      console.error(`Another unclawed instance may be running.`)
      console.error(`To use a different port: CLI_PORT=3003 unclawed\n`)
    } else {
      console.error(`Server error: ${err.message}`)
    }
    process.exit(1)
  })

  server.listen(CLI_PORT, async () => {
    const { loadScheduledTasks } = await import('./lib/scheduler.js')
    await loadScheduledTasks(runTaskInBackground)
  })

  await runSetupIfNeeded()

  const rlForChrome = readline.createInterface({ input: process.stdin, output: process.stdout })
  const chromePrompt = (q: string) => new Promise<string>(res => rlForChrome.question(q, res))
  const shouldContinue = await checkChromeOrExit(chromePrompt)
  rlForChrome.close()
  if (!shouldContinue) { process.exit(0) }

  const userId = await waitForExtension()
  console.log('✅ Chrome extension connected. Jarvis is ready.\n')

  // Recover any missions that were running when the CLI last crashed or was killed.
  // Must come before the main readline loop so the scheduler is live before the first prompt.
  {
    const { initMissionTables } = await import('./lib/mission/state-store.js')
    const { recoverRunningMissions } = await import('./lib/mission/controller.js')
    initMissionTables()
    const recovered = recoverRunningMissions((mId, msg) => console.log(`  [mission:${mId.slice(0, 8)}] ${msg}`))
    if (recovered > 0) console.log(`  ♻️  Recovering ${recovered} interrupted mission(s)...\n`)
  }

  // Open a new CLI session scoped to this folder
  const { openCliSession, incrementSessionTaskCount, generateSessionTitle, loadSessionTurns, saveSessionTurn, compactSessionTurns, countActiveSessionTurns } = await import('./lib/session-manager.js')
  _currentCliSessionId = openCliSession(userId || 'local', process.cwd())

  // Seed conversation history from the resumed session's stored turns.
  // Real turns take priority over the summary block (backward-compat fallback for old sessions).
  // _seededConvState is picked up below at the conversationalState declaration (avoids TDZ).
  let _seededConvState: ConversationalState | null = null
  if (_resumedFromSessionId) {
    const turns = loadSessionTurns(_resumedFromSessionId, 30)
    if (turns.length > 0) {
      _sessionMessages = turns
      const label = _resumedSessionTitle || 'previous session'
      _sessionResumeContext = undefined // turns loaded — don't also inject the summary block
      console.log(`🔁 Resumed: "${label}" — ${turns.length} prior turn${turns.length !== 1 ? 's' : ''} loaded\n`)

      // Seed conversationalState from the last exchange so resolveReferences works immediately.
      // Entity extraction is skipped (expensive LLM call) — the model resolves entities from
      // conversationHistory. This covers "refine that", "make it longer", "edit bullet 2" on turn 1.
      const lastUser = [...turns].reverse().find(t => t.role === 'user')
      const lastAsst = [...turns].reverse().find(t => t.role === 'assistant')
      if (lastUser && lastAsst) {
        _seededConvState = {
          entities: [],
          last_task: lastUser.content,
          last_result: lastAsst.content,
          topic: '',
          last_tab_id: 0,
          turn: Math.floor(turns.length / 2),
        }
      }
    }
  }

  if (_sessionResumeContext) {
    console.log(`🔁 Context loaded from: "${_resumedSessionTitle || 'previous session'}"\n`)
  }

  // SQLite datetime('now') uses "YYYY-MM-DD HH:MM:SS" — must match for comparisons
  const sessionStartIso = new Date().toISOString().replace('T', ' ').slice(0, 19)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.on('close', () => shutdown('Terminal closed'))
  rl.on('line', _dispatchLine)  // capture ALL lines into buffer before any await
  // When readline is idle (waiting at the prompt) it intercepts Ctrl+C and emits
  // 'SIGINT' on the rl interface instead of the process-level signal. Wire the
  // same handler so double-Ctrl+C works whether or not a task is running.
  rl.on('SIGINT', _handleSigint)

  // Escape key — abort the running agent without exiting.
  // emitKeypressEvents fires keypress events for special keys (Escape, arrows, etc.)
  // without needing raw mode, so readline's line-editing and Ctrl+C handling are unaffected.
  readline.emitKeypressEvents(process.stdin, rl)
  process.stdin.on('keypress', (_str, key) => {
    if (key?.name === 'escape' && !key.sequence?.startsWith('\x1b[')) {
      if (activeAgents.size > 0) {
        for (const ctrl of activeAgents) { try { ctrl.abort() } catch {} }
        process.stderr.write('\n  ⚠ Agent interrupted. Type a new task or /help.\n\n')
      }
    }
  })

  const _promptFn = (q: string) => prompt(rl, q)

  // ── First-run onboarding ──────────────────────────────────────────────────
  if (!isOnboarded()) {
    await runOnboarding(_promptFn)
  } else if (isProfileEmpty()) {
    // ── Profile nudge (returning users without a profile) ──────────────────
    console.log('─'.repeat(55))
    console.log('  No profile set up yet.')
    console.log('  Run /profile setup (~5 min) to make every task smarter.')
    console.log('─'.repeat(55) + '\n')
  } else {
    const freshness = getGoalsFreshness()
    if (freshness.stale) {
      console.log(`💡 Your goals were last updated ${freshness.daysOld} days ago (${freshness.dateStr}).`)
      const yn = (await prompt(rl, '   Update them now? (y/n) > ')).trim().toLowerCase()
      if (yn === 'y' || yn === 'yes') {
        await updateProfileSection('goals', _promptFn)
      } else {
        console.log()
      }
    }
  }

  // Init directories and files
  initMemoryMd()
  initContextDirs()
  initSuggestionsMd()
  cleanStaleTasks()

  // Absence flush: if user has been away > 10 days, re-score and archive stale insights
  try {
    const sessionUserId = getConnectedUserId() || 'local'
    const { runAbsenceFlush, daysSinceLastSession } = await import('./lib/action-engine/flush.js')
    const days = daysSinceLastSession(sessionUserId)
    if (days !== null && days >= 10) {
      const archived = runAbsenceFlush(sessionUserId)
      if (archived > 0) {
        console.log(`💡 ${archived} stale insight${archived > 1 ? 's' : ''} cleared after ${days}-day absence.\n`)
      }
    }
  } catch {}

  // Notify about pending memory writes (once per session)
  const pendingCount = getPendingCount()
  if (pendingCount > 0) {
    console.log(`💡 ${pendingCount} memory update${pendingCount > 1 ? 's' : ''} pending approval. Run /memory pending to review.\n`)
  }

  // Notify about pending automation suggestions (once per launch)
  const suggCount = getPendingSuggestionCount()
  if (suggCount > 0) {
    console.log(`💡 ${suggCount} automation suggestion${suggCount > 1 ? 's' : ''} waiting. Run /suggestions to review.\n`)
  }

  // Notify about skill drafts and proposals pending review
  try {
    const launchUserId = getConnectedUserId() || 'local'
    const inbox = getSkillInboxCount(launchUserId)
    const parts: string[] = []
    if (inbox.drafts > 0) parts.push(`${inbox.drafts} skill draft${inbox.drafts > 1 ? 's' : ''}`)
    if (inbox.proposals > 0) parts.push(`${inbox.proposals} improvement proposal${inbox.proposals > 1 ? 's' : ''}`)
    if (parts.length) {
      console.log(`💡 ${parts.join(' · ')} pending review — /drafts  /proposals\n`)
    }
  } catch {}

  // ── Continuity layer — commitments + in-progress tasks (highest priority) ──
  try {
    const sessionUserId = getConnectedUserId() || 'local'
    const { checkDueCommitments, markCommitmentFired, cancelCommitment, expireStaleCommitments } = await import('./lib/continuity/commitments.js')
    const { getRecentInProgress, resolveInProgress, abandonInProgress, touchInProgress, markPrompted } = await import('./lib/continuity/inprogress.js')

    // Surface expired commitment notices quietly
    const expired = expireStaleCommitments(sessionUserId)
    for (const c of expired) {
      console.log(`💡 I was tracking "${c.description}" but its trigger never fired. Cleared.\n`)
    }

    // Check fired commitments first — highest continuity priority
    const dueCommitments = checkDueCommitments(sessionUserId)
    if (dueCommitments.length > 0) {
      const c = dueCommitments[0]  // surface one at a time
      markCommitmentFired(c.id)
      const ctx = c.context ? ` (context: ${c.context.slice(0, 60)})` : ''
      console.log(`\nI was tracking something for you — "${c.description}"${ctx}`)
      const cAns = (await prompt(rl, '  Still relevant? (y/n/skip) > ')).trim().toLowerCase()
      if (/^(n|no)/.test(cAns)) {
        console.log('  Cleared.\n')
      } else if (/^(y|yes)/.test(cAns)) {
        console.log('  Keeping it in mind.\n')
      } else {
        console.log()
      }
      if (dueCommitments.length > 1) {
        console.log(`  (${dueCommitments.length - 1} more commitment${dueCommitments.length > 2 ? 's' : ''} also due — /commitments to see them)\n`)
      }
    } else {
      // Check recent in-progress tasks
      const recent = getRecentInProgress(sessionUserId)
      if (recent.length > 0) {
        const ipt = recent[0]
        markPrompted(ipt.id)
        const daysAgo = Math.floor((Date.now() - new Date(ipt.last_session_at).getTime()) / 86400000)
        const when = daysAgo === 0 ? 'earlier today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`
        console.log(`\nYou were working on "${ipt.task_description.slice(0, 80)}" ${when}.`)
        if (ipt.next_steps) console.log(`  Next: ${ipt.next_steps.slice(0, 120)}`)
        const iAns = (await prompt(rl, '  Continue, or skip it? (c/skip/later) > ')).trim().toLowerCase()
        if (iAns === 'c' || iAns === 'continue' || iAns === 'y') {
          touchInProgress(ipt.id)
          console.log(`  Continuing. I'll remember the context.\n`)
        } else if (/^(done|finished|complete|completed)/.test(iAns)) {
          resolveInProgress(ipt.id)
          console.log('  Marked complete.\n')
        } else if (!iAns || iAns === 'skip' || iAns === 's' || /^(drop|abandon|not anymore|no)/.test(iAns)) {
          // skip = abandon: user doesn't want to be reminded about this anymore
          abandonInProgress(ipt.id)
          console.log()
        } else if (iAns === 'later' || iAns === 'l') {
          // later = snooze 20h, comes back next session
          console.log()
        } else {
          abandonInProgress(ipt.id)
          console.log()
        }
      }
    }
  } catch {}

  // Proactive check-in — asks about the most overdue open thread before starting
  try {
    const sessionUserId = getConnectedUserId() || 'local'
    const topItem = getTopOverdueItem(sessionUserId)
    if (topItem) {
      const days = daysSince(topItem.opened_at)
      const daysLabel = days === 1 ? 'yesterday' : `${days} days ago`
      const who = topItem.related_person ? ` (${topItem.related_person})` : ''

      console.log(`\nHey — ${topItem.summary.toLowerCase()}${who}, ${daysLabel}. How did it go?`)
      const answer = await prompt(rl, '> ')
      const lower = answer.trim().toLowerCase()

      if (!lower || lower === 'skip' || lower === 'later' || lower === 's') {
        console.log('')
      } else if (/\b(well|good|great|meeting|got|replied|yes|positive|amazing|perfect|deal|signed|accepted|interested|response|they wrote|they said|heard back|we got)\b/.test(lower)) {
        resolveItem(topItem.id)
        console.log('\nNice, marking it resolved. What are we working on today?\n')
      } else if (/\b(no|nothing|ghosted|rejected|silence|waiting|still|didn'?t|haven'?t|not yet|no reply|no response)\b/.test(lower)) {
        console.log('\nGot it. Want me to draft a follow-up? Just say the word.\n')
      } else {
        console.log('\nOkay, keeping it open. What are we working on?\n')
      }

      const remaining = getOverdueOpenItems(sessionUserId).length
      if (remaining > 0) {
        console.log(`(${remaining} more open thread${remaining > 1 ? 's' : ''} — /followups to see them)\n`)
      }
    } else {
      // No overdue open items — check for due Level 2 autonomous executions first, then Tier 1 insight
      let autonomousShown = false
      try {
        const { runDueExecutions, markExecutionSurfaced, markExecutionConfirmed, markExecutionCancelled } = await import('./lib/action-engine/autonomous/executor.js')
        const executions = runDueExecutions(sessionUserId)
        if (executions.length > 0) {
          const exec = executions[0]  // one item per session rule
          markExecutionSurfaced(exec.id)
          autonomousShown = true
          const LINE_AUTO = '─'.repeat(55)
          console.log(`\n${LINE_AUTO}`)
          console.log(`  ${exec.title.toUpperCase()}`)
          console.log(LINE_AUTO)
          console.log(exec.content)
          console.log(LINE_AUTO)
          const autoAns = (await prompt(rl, '  [c] confirm  [x] cancel  [skip] skip > ')).trim().toLowerCase()
          if (autoAns === 'c' || autoAns === 'confirm' || autoAns === 'y') {
            markExecutionConfirmed(exec.id)
            console.log('  ✓ Noted.\n')
          } else if (autoAns === 'x' || autoAns === 'cancel' || autoAns === 'n') {
            markExecutionCancelled(exec.id, sessionUserId, exec.category)
            console.log('  Cancelled.\n')
          } else {
            console.log()
          }
        }
      } catch {}

      if (!autonomousShown) try {
        const { pickTopInsight, recordActionMemory, markSurfaced, markActed, markDismissed, requeueDeferred } = await import('./lib/action-engine/surface.js')
        const insight = pickTopInsight(sessionUserId, sessionStartIso, 1)
        if (insight && !_sessionSkippedInsightCategories.has(insight.action.action_category)) {
          // LLM judges whether this is genuinely notable + generates a fresh question
          const judgment = await generateInsightQuestion(sessionUserId, insight.action)
          if (judgment.shouldSurface) {
          markSurfaced(insight.action.id, insight.score)

          const isCompound = insight.action.insight_format === 'compound'
          if (isCompound) {
            // Compound: show evidence bullets, then bridge, then question
            console.log(`\nI want to share something I noticed —`)
            try {
              const ev = JSON.parse(insight.action.evidence || '{}')
              if (Array.isArray(ev.observations)) {
                ev.observations.forEach((obs: string) => console.log(`  • ${obs}`))
              }
            } catch {}
            console.log(`\n${insight.action.insight_text}`)
          } else {
            console.log(`\nOne thing I noticed — ${insight.action.insight_text}`)
          }

          const q = judgment.question ? `${judgment.question} (y/n/skip/later) ` : '(y/n/skip/later) '
          let ans = (await prompt(rl, `${q}> `)).trim().toLowerCase()

          // Re-ask once if ignored — then suppress category for rest of session
          if (!ans || ans === 'skip' || ans === 's') {
            const retry = (await prompt(rl, `  ${q}> `)).trim().toLowerCase()
            if (!retry || retry === 'skip' || retry === 's') {
              _sessionSkippedInsightCategories.add(insight.action.action_category)
            } else {
              ans = retry
            }
          }

          let response = 'ignored'
          if (!ans || ans === 'skip' || ans === 's') {
            response = 'ignored'
            console.log('')
          } else if (/^(y|yes|yeah|yep|definitely|exactly|true)/.test(ans)) {
            response = 'acted'
            markActed(insight.action.id)
            console.log('\nGot it, keeping that in mind.\n')
            // Chain: queue a followup suggestion for next session (not this one — chain rush prevention)
            try {
              const { maybeQueueChainFollowup } = await import('./lib/action-engine/chain.js')
              maybeQueueChainFollowup(sessionUserId, insight.action.action_category)
            } catch {}
            // Auto-authorize when user says yes to a chain insight that implies enabling an autonomous category
            try {
              const cat = insight.action.action_category
              if (cat === 'chain_relationship_touchpoints' || cat === 'chain_session_prep') {
                const { createAuthorization } = await import('./lib/action-engine/autonomous/authorization.js')
                const authCat = cat === 'chain_relationship_touchpoints' ? 'relationship_touchpoints' : 'session_prep'
                createAuthorization(sessionUserId, authCat, 3)
                console.log(`  ✓ Authorized: ${authCat} will prepare automatically (Level 3 — you confirm each one). Run /actions revoke ${authCat} to disable.\n`)
              }
            } catch {}
            // Save inprogress breadcrumb for chains that don't have autonomous execution yet
            try {
              const CHAIN_BREADCRUMBS: Record<string, string> = {
                chain_calibration:       'Build calibration brief: targeted questions in areas of consistent agent error',
                chain_timing_tracking:   'Add timing pattern tracking to session prep brief',
                chain_goal_alignment:    'Add weekly goal alignment check to session prep brief',
              }
              const breadcrumb = CHAIN_BREADCRUMBS[insight.action.action_category]
              if (breadcrumb) {
                const { saveInProgress } = await import('./lib/continuity/inprogress.js')
                saveInProgress(sessionUserId, breadcrumb, insight.action.insight_text.slice(0, 300), null, null)
                console.log("  ✓ Saved — I'll remind you next session.\n")
              }
            } catch {}
          } else if (/\b(later|remind me|defer|not now|come back)\b/i.test(ans)) {
            response = 'deferred'
            requeueDeferred(insight.action.id)
            console.log("\nGot it, I'll bring it up again.\n")
          } else if (/^(n|no|nah|nope|not really)/.test(ans)) {
            response = 'dismissed'
            markDismissed(insight.action.id)
            console.log('\nOkay, noted.\n')
            // Chain break: if this was a chain followup, block re-proposal for 90 days
            try {
              const { recordChainBreak } = await import('./lib/action-engine/chain.js')
              if (insight.action.action_category.startsWith('chain_')) {
                recordChainBreak(sessionUserId, insight.action.action_category)
              }
            } catch {}
          } else {
            response = 'engaged'
            console.log('\nGot it.\n')
          }

          recordActionMemory(sessionUserId, insight.action.id, insight.action.action_category, response, insight.window, insight.score)
          } // judgment.shouldSurface
        }
      } catch {}
    }
  } catch {}

  // Session-level skill attachments — cleared after each task completes
  const sessionAttachedSkillIds: string[] = []

  // Conversational state — updated after every task, used to resolve follow-up references.
  // Pre-seeded from the resumed session's last exchange when resuming (see _seededConvState above).
  let conversationalState: ConversationalState | null = _seededConvState

  async function runTask(task: string): Promise<void> {
    // Hoisted: set at each result branch so the finally block can persist turns
    let _taskTurnResult: { userTurn: string; assistantTurn: string } | undefined
    const currentUserId = await ensureConnected((q) => prompt(rl, q))
    if (!currentUserId) return

    // ── Auto-compact ─────────────────────────────────────────────────────────
    // Fires when the in-memory window is ≥ 85% full (≥ 17 of 20) AND there are
    // enough DB turns to make compaction worthwhile (≥ 20 active turns).
    // Runs BEFORE the task executes so the agent gets a clean, compacted context.
    const _estimatedTokens = _sessionMessages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0)
    if (_currentCliSessionId && _estimatedTokens >= 8_000) {
      try {
        const dbTurns = countActiveSessionTurns(_currentCliSessionId)
        if (dbTurns >= 20) {
          const LINE_AC = '─'.repeat(51)
          console.log(`\n  ${LINE_AC}`)
          console.log('  auto-compact: summarizing older turns...')
          const acResult = await compactSessionTurns(_currentCliSessionId)
          if (acResult) {
            const freshTurns = loadSessionTurns(_currentCliSessionId, 200)
            _sessionMessages = freshTurns.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content }))
            if (_sessionMessages.length > 20) _sessionMessages = _sessionMessages.slice(-16)
            console.log(`  ✓ ${acResult.compacted} turns → 1 summary. Continuing...`)
          }
          console.log(`  ${LINE_AC}\n`)
        }
      } catch { /* non-fatal — task proceeds with existing context */ }
    }

    // ── Skill suggestion (pre-run) ────────────────────────────────────────────
    // Check if any saved skills are relevant to this task. Show suggestions and
    // allow the user to attach them before the agent starts.
    try {
      const suggestions = await searchSkillsForTask(currentUserId, task)
      const unattached = suggestions.filter(s => !sessionAttachedSkillIds.includes(s.skill_id))
      if (unattached.length) {
        console.log(`\n💡 Relevant skill${unattached.length > 1 ? 's' : ''} found:`)
        unattached.forEach((s, i) => console.log(`   ${i + 1}. ${s.skill_name} — ${s.why_relevant}`))
        if (unattached.length === 1) {
          const answer = await prompt(rl, `   Attach it? [y/n] `)
          if (answer.trim().toLowerCase() === 'y') {
            sessionAttachedSkillIds.push(unattached[0].skill_id)
            console.log(`   ✓ ${unattached[0].skill_name} attached.\n`)
          } else {
            console.log()
          }
        } else {
          const answer = await prompt(rl, `   Attach which? [all / 1 2 3 / n] `)
          const trimmed = answer.trim().toLowerCase()
          if (!trimmed || trimmed === 'n' || trimmed === 'no' || trimmed === 'none') {
            console.log()
          } else {
            let toAttach: typeof unattached
            if (trimmed === 'y' || trimmed === 'yes' || trimmed === 'all') {
              toAttach = unattached
            } else {
              const indices = trimmed.split(/[\s,]+/).map(t => parseInt(t) - 1).filter(i => i >= 0 && i < unattached.length)
              toAttach = [...new Set(indices)].map(i => unattached[i])
            }
            if (toAttach.length) {
              sessionAttachedSkillIds.push(...toAttach.map(s => s.skill_id))
              console.log(`   ✓ ${toAttach.map(s => s.skill_name).join(', ')} attached.\n`)
            } else {
              console.log()
            }
          }
        }
      }
    } catch {
      // Suggestion failure is non-fatal — silently skip
    }

    // Collect runtime variable values for attached skills (if any define them).
    // Pre-fill from the task text first — only ask for vars not already in the task.
    let skillVarValues: Record<string, string> = {}
    if (sessionAttachedSkillIds.length) {
      const skillVars = getAttachedSkillVariables(sessionAttachedSkillIds)
      if (skillVars.length) {
        const prefilled = await prefillVarsFromTask(skillVars, task)
        skillVarValues = await collectRuntimeVars(rl, skillVars, prefilled)
      }
    }

    // Build context block from attached skills (substituting any collected variable values)
    const skillsContext = buildAttachedSkillsContext(sessionAttachedSkillIds, skillVarValues)

    // Reference resolution — resolve pronouns/demonstratives against conversational state
    let effectiveTask = task
    let continuationContext = ''
    let resumeTabId: number | undefined
    let referenceResolved = false   // true when resolveReferences confirmed a follow-up (skips confidence check)
    if (conversationalState) {
      const resolution = await resolveReferences(task, conversationalState)
      if (resolution.confidence >= 70 && resolution.intent !== 'new_task') {
        effectiveTask = resolution.annotated
        continuationContext = buildContinuationContext(conversationalState, resolution.resolved_entities)
        resumeTabId = conversationalState.last_tab_id > 0 ? conversationalState.last_tab_id : undefined
        referenceResolved = true
        const lastTab = getLastUsedTab(currentUserId)
        if (lastTab) {
          console.log(`\n🔁 Resuming from: "${lastTab.title.slice(0, 60)}" (${lastTab.url.slice(0, 70)})\n`)
        }
      } else if (resolution.confidence >= 40 && resolution.intent !== 'new_task' && resolution.clarification_question) {
        console.log()
        const clarified = (await prompt(rl, `  ${resolution.clarification_question} `)).trim()
        if (clarified) {
          effectiveTask = `${resolution.annotated} (${clarified})`
          continuationContext = buildContinuationContext(conversationalState, resolution.resolved_entities)
          resumeTabId = conversationalState.last_tab_id > 0 ? conversationalState.last_tab_id : undefined
        }
      }
    }

    // Inject resumed session context into the first task only, then clear it
    const resumePrefix = (_sessionTaskCount === 0 && _sessionResumeContext)
      ? _sessionResumeContext + '\n\n'
      : ''
    if (_sessionTaskCount === 0 && _sessionResumeContext) _sessionResumeContext = undefined

    const taskWithSkills = resumePrefix + (skillsContext ? `${skillsContext}\n${effectiveTask}` : effectiveTask)

    // Mission mode check — offer to launch as a multi-division mission for complex goals
    try {
      const launchedAsMission = await checkMissionMode(effectiveTask, currentUserId, async (q) => {
        _lineQueue.length = 0           // discard queued lines
        const raw = await prompt(rl, q)
        const trimmed = raw.trim().toLowerCase()
        // If the answer is unusually long it means readline prepended buffered paste content
        // (unterminated last paste line) to the user's actual keypress. Extract the last char.
        return trimmed.length > 20 ? trimmed.slice(-1) : trimmed
      })
      if (launchedAsMission) return
    } catch (err: any) {
      console.error(`\n[mission] Error: ${err?.message ?? err}\n`)
      /* non-fatal — proceed with normal task execution */
    }

    const taskStartTime = Date.now()
    const taskRunId = `${currentUserId}-${taskStartTime}`
    const ac = new AbortController()
    activeAgents.add(ac)
    let lastLine = ''
    const onStep = async (step: string) => {
      if (lastLine) process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r')
      lastLine = step
      process.stdout.write(step)
    }
    const onConfirmationRequest = async (req: import('./lib/agent-extension.js').ConfirmationRequest): Promise<import('./lib/agent-extension.js').ConfirmationResponse> => {
      // Clear the current progress line before rendering the confirmation UI
      if (lastLine) { process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r'); lastLine = '' }
      return handleConfirmationRequest(rl, req)
    }

    try {
      // ── Channel extraction (fire-and-forget, mirrors tasks.ts pipeline) ───────
      ;(async () => { try { const { extractChannelASignals } = await import('./lib/channel-a/extractor.js'); extractChannelASignals(currentUserId, effectiveTask, null, conversationalState?.turn ?? 0) } catch {} })()
      ;(async () => { try { const { extractChannelBSignals } = await import('./lib/channel-b/extractor.js'); const lastAsst = conversationalState?.last_result ?? null; if (lastAsst) extractChannelBSignals(currentUserId, effectiveTask, lastAsst, new Date().toISOString(), conversationalState?.last_task ?? null, taskRunId) } catch {} })()
      ;(async () => { try { const { extractChannelDAnswer } = await import('./lib/channel-d/answer-extractor.js'); extractChannelDAnswer(currentUserId, taskRunId, effectiveTask) } catch {} })()
      ;(async () => { try { const { checkAssumptionCorrectionTrigger, checkPressureTrigger } = await import('./lib/channel-d/trigger-detector.js'); checkAssumptionCorrectionTrigger(currentUserId, taskRunId, effectiveTask); checkPressureTrigger(currentUserId, taskRunId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackMessage } = await import('./lib/channel-f/relationship-tracker.js'); trackMessage(currentUserId, taskRunId, effectiveTask) } catch {} })()
      ;(async () => { try { const { detectOutcomeSignal } = await import('./lib/channel-h/outcome-detector.js'); detectOutcomeSignal(currentUserId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackDecisionSignal } = await import('./lib/channel-i/decision-tracker.js'); trackDecisionSignal(currentUserId, taskRunId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackInfoDiet } = await import('./lib/channel-j/info-diet-tracker.js'); trackInfoDiet(currentUserId, taskRunId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackCognitiveSignal } = await import('./lib/channel-k/cognitive-tracker.js'); trackCognitiveSignal(currentUserId, taskRunId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackResistanceSignal } = await import('./lib/channel-l/resistance-tracker.js'); trackResistanceSignal(currentUserId, taskRunId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackVocabulary } = await import('./lib/channel-m/vocabulary-tracker.js'); trackVocabulary(currentUserId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackWorldSignals } = await import('./lib/channel-n/event-tracker.js'); trackWorldSignals(currentUserId, effectiveTask) } catch {} })()
      ;(async () => { try { const { trackAchievement } = await import('./lib/channel-o/achievement-tracker.js'); trackAchievement(currentUserId, effectiveTask) } catch {} })()
      ;(async () => { try { const { detectAndSaveDirectives } = await import('./lib/behavioral-contract/detector.js'); detectAndSaveDirectives(currentUserId, effectiveTask, conversationalState?.last_task ?? '') } catch {} })()
      ;(async () => { try { const { updateLiveState } = await import('./lib/live-state/updater.js'); updateLiveState(currentUserId, taskRunId, effectiveTask) } catch {} })()
      // ── End channel extraction ─────────────────────────────────────────────────

      const result = await orchestrateTask(taskWithSkills, currentUserId, undefined, {
        signal: ac.signal,
        rawTask: effectiveTask,
        // Truncate each turn to 400 chars for the API call — the model sees the gist of
        // prior turns without token explosion. Full content stays in _sessionMessages for DB persistence.
        conversationHistory: _sessionMessages.length > 0
          ? (() => {
              // Adaptive per-turn budget: fewer turns → can afford more chars per turn.
              // 12 000 chars total divided evenly, clamped to [400, 1500].
              const perTurn = Math.max(400, Math.min(1500, Math.floor(12000 / _sessionMessages.length)))
              return _sessionMessages.map(m => ({ role: m.role, content: m.content.slice(0, perTurn) }))
            })()
          : undefined,
        // Hermes NODE 8: pass cached channel context so it's built only on the first chat call.
        cachedChannelContext: _cachedChannelContext,
        onChannelContextBuilt: (ctx) => { _cachedChannelContext = ctx },
        // Skip confidence check when resolveReferences already confirmed this is a follow-up.
        // The reference resolver is more context-aware than the confidence scorer for these cases.
        skipConfidenceCheck: referenceResolved,
      })

      if (result.type === 'chat') {
        console.log('\n' + result.response + '\n')
        _taskTurnResult = { userTurn: effectiveTask, assistantTurn: result.response.slice(0, 1500) }
        const chatDuration = Math.round((Date.now() - taskStartTime) / 1000)
        archiveSession({ taskPrompt: effectiveTask, taskSummary: result.response.slice(0, 800), taskType: 'chat', outcome: 'completed', durationSeconds: chatDuration, userId: currentUserId, cliSessionId: _currentCliSessionId })
        runBackgroundReview({ taskPrompt: effectiveTask, taskSummary: result.response.slice(0, 800), taskType: 'chat', outcome: 'completed', durationSeconds: chatDuration, userId: currentUserId, cliSessionId: _currentCliSessionId }).catch(() => {})
        // Update conversational state so follow-ups like "okay then publish this" can resolve
        try {
          const newTurn = (conversationalState?.turn ?? 0) + 1
          const { entities: newEntities, topic: newTopic } = await extractEntities(task, result.response, newTurn)
          const allEntities = [...(conversationalState?.entities ?? []), ...newEntities].slice(-30)
          conversationalState = {
            entities: allEntities,
            last_task: task,
            last_result: result.response,
            topic: newTopic || conversationalState?.topic || '',
            last_tab_id: conversationalState?.last_tab_id ?? 0,
            turn: newTurn,
          }
        } catch {}
        // If the user asked to draft a post for a specific platform, offer to publish it now
        const platformMatch = /\b(linkedin|twitter|instagram|facebook|x\.com)\b/i.exec(task)
        const isDraftIntent = /\b(write|draft|create|suggest|give me|help me|make)\b/i.test(task)
        const isPostIntent = /\b(post|tweet|publish|share|send)\b/i.test(task)
        if (platformMatch && (isDraftIntent || isPostIntent)) {
          const platformKey = platformMatch[0].toLowerCase()
          const platform = PLATFORM_NAMES[platformKey] || platformKey.charAt(0).toUpperCase() + platformKey.slice(1)
          const yn = (await prompt(rl, `📤 Post this to ${platform}? (y/n) > `)).trim().toLowerCase()
          if (yn === 'y' || yn === 'yes') {
            const postContent = await extractPostContent(result.response)
            await runTask(`Go to ${platform} and post this exact content — do not change a single word:\n\n${postContent}`)
          }
        }
        await maybeSurfaceProfileQuestion((q) => prompt(rl, q), effectiveTask)
        return
      }

      if (result.type === 'hybrid') {
        const output = await executeHybridTask(result.task, currentUserId, onStep, onConfirmationRequest, ac.signal)
        if (lastLine) process.stdout.write('\n')
        console.log('\n✅ ' + output + '\n')
        _taskTurnResult = { userTurn: effectiveTask, assistantTurn: output.slice(0, 1500) }
        archiveSession({ taskPrompt: effectiveTask, taskSummary: output.slice(0, 800), taskType: 'browser', outcome: 'completed', durationSeconds: Math.round((Date.now() - taskStartTime) / 1000), userId: currentUserId, cliSessionId: _currentCliSessionId })
        return
      }

      if (result.type === 'clarify') {
        console.log('\n' + result.message)
        result.questions.forEach((q: string, i: number) => console.log(`  ${i + 1}. ${q}`))
        const answers: string[] = []
        for (let i = 0; i < result.questions.length; i++) {
          const a = (await prompt(rl, `  Answer ${i + 1}: `)).trim()
          // Include the question text with the answer so the agent has full context
          answers.push(`${result.questions[i]}\n→ ${a}`)
        }
        console.log()
        // Build a richer prompt for the review that includes clarification answers
        const clarifiedPrompt = answers.length
          ? `${task}\n[Clarified: ${answers.map(a => a.replace(/\n→ /g, ': ')).join(' | ')}]`
          : task

        const clarifiedResult = await orchestrateTask(task, currentUserId, answers)
        if (clarifiedResult.type === 'browser' || clarifiedResult.type === 'local') {
          const clarifiedCtx = [skillsContext, continuationContext, clarifiedResult.context].filter(Boolean).join('\n\n')

          if (clarifiedResult.type === 'browser') createTaskMd(taskRunId, clarifiedPrompt)

          // Person knowledge check for clarified browser tasks
          let clarifiedPersonCtx = ''
          if (clarifiedResult.type === 'browser') {
            const knownPeople = getKnownPeople()
            const knownPerson = findKnownPersonInTask(clarifiedPrompt, knownPeople)
            if (knownPerson) {
              const staleNote = knownPerson.isStale ? ' (may be stale — over 60 days old)' : ''
              console.log(`\n💡 I have notes on ${knownPerson.name}${staleNote}:`)
              console.log(`   ${knownPerson.line}`)
              const ans = (await prompt(rl, '\n   Add these to task context? (y/n) > ')).trim().toLowerCase()
              if (ans === 'y' || ans === 'yes') {
                clarifiedPersonCtx = `\n[Existing notes on ${knownPerson.name}]: ${knownPerson.line}`
              }
            }
          }

          const taskWithClarifiedPersonCtx = clarifiedPersonCtx ? `${effectiveTask}${clarifiedPersonCtx}` : effectiveTask
          const output = await runAgentWithExtension(taskWithClarifiedPersonCtx, currentUserId, onStep, undefined, false, clarifiedCtx || undefined, ac.signal, false, false, undefined, onConfirmationRequest, clarifiedResult.type === 'local')
          if (lastLine) process.stdout.write('\n')
          const clarifiedSucceeded = wasLastAgentRunSuccessful()
          if (!clarifiedSucceeded) {
            console.log('\n❌ ' + output + '\n')
            await maybeOfferSkillCreation(rl, currentUserId, effectiveTask)
          } else {
            console.log('\n✅ ' + output + '\n')
          }
          _taskTurnResult = { userTurn: effectiveTask, assistantTurn: output.slice(0, 1500) }
          await maybeShowStandingPermissionSuggestion(rl)

          if (clarifiedResult.type === 'local') {
            const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000)
            archiveSession({ taskPrompt: clarifiedPrompt, taskSummary: output.slice(0, 800), taskType: 'local', outcome: clarifiedSucceeded ? 'completed' : 'failed', durationSeconds, userId: currentUserId, cliSessionId: _currentCliSessionId })
          }
          // Archive TASK.md + background review + platform tracking for clarified browser tasks
          if (clarifiedResult.type === 'browser') {
            archiveTaskMd(taskRunId, clarifiedSucceeded ? 'completed' : 'failed', output.slice(0, 200))
            const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000)
            runBackgroundReview({
              taskPrompt: clarifiedPrompt,
              taskSummary: output,
              taskType: 'browser',
              outcome: clarifiedSucceeded ? 'completed' : 'failed',
              durationSeconds,
              userId: currentUserId,
            }).catch(() => {})

            const platform = detectPlatform(clarifiedPrompt)
            if (platform && clarifiedSucceeded) {
              incrementPlatformCount(platform, currentUserId)
              if (shouldProposeContextFile(platform, currentUserId)) {
                console.log(`\n💡 You've completed 3 ${platform} tasks. Want me to create a context file for faster ${platform} work? (y/n)`)
                const ans = (await prompt(rl, '> ')).trim().toLowerCase()
                if (ans === 'y' || ans === 'yes') {
                  console.log(`  Drafting ${platform}.md...`)
                  const draft = await draftContextFile(platform, currentUserId)
                  saveContextFile(platform, draft)
                  console.log(`  ✓ Saved. Edit with /context edit ${platform}\n`)
                }
              }
            }
          }
        } else if (clarifiedResult.type === 'hybrid') {
          const output = await executeHybridTask(clarifiedResult.task, currentUserId, onStep, onConfirmationRequest, ac.signal)
          if (lastLine) process.stdout.write('\n')
          console.log('\n✅ ' + output + '\n')
          _taskTurnResult = { userTurn: effectiveTask, assistantTurn: output.slice(0, 1500) }
          archiveSession({ taskPrompt: clarifiedPrompt, taskSummary: output.slice(0, 800), taskType: 'browser', outcome: 'completed', durationSeconds: Math.round((Date.now() - taskStartTime) / 1000), userId: currentUserId, cliSessionId: _currentCliSessionId })
        } else if (clarifiedResult.type === 'chat') {
          console.log('\n' + clarifiedResult.response + '\n')
          _taskTurnResult = { userTurn: effectiveTask, assistantTurn: clarifiedResult.response.slice(0, 1500) }
          const clarChatDuration = Math.round((Date.now() - taskStartTime) / 1000)
          archiveSession({ taskPrompt: clarifiedPrompt, taskSummary: clarifiedResult.response.slice(0, 800), taskType: 'chat', outcome: 'completed', durationSeconds: clarChatDuration, userId: currentUserId, cliSessionId: _currentCliSessionId })
          runBackgroundReview({ taskPrompt: clarifiedPrompt, taskSummary: clarifiedResult.response.slice(0, 800), taskType: 'chat', outcome: 'completed', durationSeconds: clarChatDuration, userId: currentUserId, cliSessionId: _currentCliSessionId }).catch(() => {})
          try {
            const newTurn = (conversationalState?.turn ?? 0) + 1
            const { entities: newEntities, topic: newTopic } = await extractEntities(task, clarifiedResult.response, newTurn)
            const allEntities = [...(conversationalState?.entities ?? []), ...newEntities].slice(-30)
            conversationalState = {
              entities: allEntities,
              last_task: task,
              last_result: clarifiedResult.response,
              topic: newTopic || conversationalState?.topic || '',
              last_tab_id: conversationalState?.last_tab_id ?? 0,
              turn: newTurn,
            }
          } catch {}
        }
        return
      }

      const combinedCtx = [skillsContext, continuationContext, result.context].filter(Boolean).join('\n\n')
      const isLocalOnly = result.type === 'local'

      // Person knowledge check — offer to inject known notes before task runs
      let personContext = ''
      if (result.type === 'browser') {
        const knownPeople = getKnownPeople()
        const knownPerson = findKnownPersonInTask(effectiveTask, knownPeople)
        if (knownPerson) {
          const staleNote = knownPerson.isStale ? ' (may be stale — over 60 days old)' : ''
          console.log(`\n💡 I have notes on ${knownPerson.name}${staleNote}:`)
          console.log(`   ${knownPerson.line}`)
          const ans = (await prompt(rl, '\n   Add these to task context? (y/n) > ')).trim().toLowerCase()
          if (ans === 'y' || ans === 'yes') {
            personContext = `\n[Existing notes on ${knownPerson.name}]: ${knownPerson.line}`
          }
        }
      }

      // Create TASK.md at start of browser tasks (crash-recovery + resume)
      if (result.type === 'browser') createTaskMd(taskRunId, effectiveTask)

      const taskWithPersonCtx = personContext ? `${effectiveTask}${personContext}` : effectiveTask
      const output = await runAgentWithExtension(taskWithPersonCtx, currentUserId, onStep, undefined, false, combinedCtx || undefined, ac.signal, false, false, resumeTabId, onConfirmationRequest, isLocalOnly)
      if (lastLine) process.stdout.write('\n')
      const taskSucceeded = wasLastAgentRunSuccessful()
      const taskStopped = output === 'Task stopped by user.'
      if (taskStopped) {
        console.log('\n  Agent stopped.\n')
      } else if (!taskSucceeded) {
        console.log('\n❌ ' + output + '\n')
        await maybeOfferSkillCreation(rl, currentUserId, effectiveTask)
      } else {
        console.log('\n✅ ' + output + '\n')
      }
      _taskTurnResult = { userTurn: effectiveTask, assistantTurn: output.slice(0, 1500) }
      if (!taskStopped) await maybeShowStandingPermissionSuggestion(rl)
      if (!taskStopped && taskSucceeded) await maybeSurfaceProfileQuestion((q) => prompt(rl, q), effectiveTask)

      // Archive TASK.md + background review + platform tracking (browser only)
      if (result.type === 'local') {
        const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000)
        archiveSession({ taskPrompt: effectiveTask, taskSummary: output.slice(0, 800), taskType: 'local', outcome: taskSucceeded ? 'completed' : 'failed', durationSeconds, userId: currentUserId, cliSessionId: _currentCliSessionId })
      }
      if (result.type === 'browser') {
        archiveTaskMd(taskRunId, taskSucceeded ? 'completed' : 'failed', output.slice(0, 200))
        const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000)
        runBackgroundReview({
          taskPrompt: effectiveTask,
          taskSummary: output,
          taskType: 'browser',
          outcome: taskSucceeded ? 'completed' : 'failed',
          durationSeconds,
          userId: currentUserId,
        }).catch(() => {})

        // Platform count tracking → context file proposal after 3rd task
        const platform = detectPlatform(effectiveTask)
        if (platform && taskSucceeded) {
          incrementPlatformCount(platform, currentUserId)
          if (shouldProposeContextFile(platform, currentUserId)) {
            console.log(`\n💡 You've completed 3 ${platform} tasks. Want me to create a context file so I work faster on ${platform} in future? (y/n)`)
            const ans = (await prompt(rl, '> ')).trim().toLowerCase()
            if (ans === 'y' || ans === 'yes') {
              console.log(`  Drafting ${platform}.md...`)
              const draft = await draftContextFile(platform, currentUserId)
              saveContextFile(platform, draft)
              console.log(`  ✓ Saved to ${contextFilePath(platform)}`)
              console.log(`  Edit anytime with /context edit ${platform}\n`)
            }
          }
        }
      }

      // Update conversational state — extract entities for future reference resolution
      try {
        const tabInfo = getLastUsedTab(currentUserId)
        const newTurn = (conversationalState?.turn ?? 0) + 1
        const { entities: newEntities, topic: newTopic } = await extractEntities(task, output, newTurn)
        const allEntities = [...(conversationalState?.entities ?? []), ...newEntities].slice(-30)
        conversationalState = {
          entities: allEntities,
          last_task: task,
          last_result: output,
          topic: newTopic || conversationalState?.topic || '',
          last_tab_id: tabInfo?.tabId ?? conversationalState?.last_tab_id ?? 0,
          turn: newTurn,
        }
      } catch {
        // State update failure is non-fatal — next turn just starts fresh
      }
    } catch (err) {
      if (lastLine) process.stdout.write('\n')
      const isAbort = (err as any)?.aborted || (err as any)?.name === 'AbortError' || ac.signal.aborted
      if (isAbort) {
        console.log('\n  Agent stopped.\n')
      } else {
        console.error('\n❌ ' + (err instanceof Error ? err.message : String(err)) + '\n')
      }
    } finally {
      activeAgents.delete(ac)

      // Post-run gap report — show any stuck situations that had no skill
      try {
        const gaps = getRecentGapEvents(currentUserId, 120)
        if (gaps.length) {
          console.log(`\n⚠️  Skill gap${gaps.length > 1 ? 's' : ''} detected during this run:`)
          gaps.forEach(g => {
            console.log(`   • [${g.stuck_type}] ${g.stuck_description}`)
            if (g.current_url) console.log(`     at: ${g.current_url}`)
          })
          const proposal = checkGapProposals(currentUserId)
          if (proposal) console.log('\n' + proposal)
          console.log()
        }
      } catch {
        // Gap report failure is non-fatal
      }

      // Post-run skill inbox notification
      try {
        const inbox = getSkillInboxCount(currentUserId)
        const parts: string[] = []
        if (inbox.drafts > 0) parts.push(`${inbox.drafts} skill draft${inbox.drafts > 1 ? 's' : ''}`)
        if (inbox.proposals > 0) parts.push(`${inbox.proposals} improvement proposal${inbox.proposals > 1 ? 's' : ''}`)
        if (parts.length) {
          console.log(`💡 ${parts.join(' · ')} ready — /drafts  /proposals\n`)
        }
      } catch {
        // Non-fatal
      }

      // Track session task count and generate title after first task
      if (_currentCliSessionId) {
        if (_sessionTaskCount === 0) generateSessionTitle(_currentCliSessionId, effectiveTask)
        incrementSessionTaskCount(_currentCliSessionId)
        _sessionTaskCount++
      }

      // Accumulate conversation history (Hermes-style in-memory + DB persist)
      if (_taskTurnResult && _currentCliSessionId) {
        _sessionMessages.push({ role: 'user', content: _taskTurnResult.userTurn })
        _sessionMessages.push({ role: 'assistant', content: _taskTurnResult.assistantTurn })
        // Simple sliding window: keep at most 20 messages (10 exchanges) in memory
        if (_sessionMessages.length > 20) _sessionMessages = _sessionMessages.slice(-16)
        // Persist to DB fire-and-forget — never blocks the next turn
        const _sid = _currentCliSessionId
        const _ut = _taskTurnResult.userTurn
        const _at = _taskTurnResult.assistantTurn
        ;(async () => { try { saveSessionTurn(_sid, 'user', _ut); saveSessionTurn(_sid, 'assistant', _at) } catch {} })()
      }

      // Clear session attachments after every task — next task starts fresh
      sessionAttachedSkillIds.length = 0

      // Tier 2 insight: surface a lower-priority item between tasks (score 4.0-6.9)
      try {
        const btUserId = getConnectedUserId() || 'local'
        const { pickTopInsight: pickT2, recordActionMemory: recT2, markSurfaced: markT2, markActed: markT2Acted, markDismissed: markT2Dismissed, requeueDeferred: requeueT2 } = await import('./lib/action-engine/surface.js')
        const t2 = pickT2(btUserId, sessionStartIso, 2)
        if (t2 && !_sessionSkippedInsightCategories.has(t2.action.action_category)) {
          const judgment2 = await generateInsightQuestion(btUserId, t2.action)
          if (judgment2.shouldSurface) {
          markT2(t2.action.id, t2.score)
          const isCompound2 = t2.action.insight_format === 'compound'
          if (isCompound2) {
            console.log(`\nI want to share something I noticed —`)
            try {
              const ev = JSON.parse(t2.action.evidence || '{}')
              if (Array.isArray(ev.observations)) {
                ev.observations.forEach((obs: string) => console.log(`  • ${obs}`))
              }
            } catch {}
            console.log(`\n${t2.action.insight_text}`)
          } else {
            console.log(`\nOne thing worth knowing — ${t2.action.insight_text}`)
          }
          const q2 = judgment2.question ? `${judgment2.question} (y/n/skip/later) ` : '(skip/later) '
          let a2 = (await prompt(rl, `${q2}> `)).trim().toLowerCase()

          // Re-ask once if ignored — then suppress category for rest of session
          if (!a2 || a2 === 'skip' || a2 === 's') {
            const retry2 = (await prompt(rl, `  ${q2}> `)).trim().toLowerCase()
            if (!retry2 || retry2 === 'skip' || retry2 === 's') {
              _sessionSkippedInsightCategories.add(t2.action.action_category)
            } else {
              a2 = retry2
            }
          }

          let r2 = 'ignored'
          if (!a2 || a2 === 'skip' || a2 === 's') { r2 = 'ignored'; console.log('') }
          else if (/^(y|yes|yeah|yep|definitely|exactly|true)/.test(a2)) {
            r2 = 'acted'; markT2Acted(t2.action.id); console.log('\nGot it.\n')
            try {
              const { maybeQueueChainFollowup } = await import('./lib/action-engine/chain.js')
              maybeQueueChainFollowup(btUserId, t2.action.action_category)
            } catch {}
            try {
              const cat2 = t2.action.action_category
              if (cat2 === 'chain_relationship_touchpoints' || cat2 === 'chain_session_prep') {
                const { createAuthorization } = await import('./lib/action-engine/autonomous/authorization.js')
                const authCat2 = cat2 === 'chain_relationship_touchpoints' ? 'relationship_touchpoints' : 'session_prep'
                createAuthorization(btUserId, authCat2, 3)
                console.log(`  ✓ Authorized: ${authCat2} will prepare automatically (Level 3 — you confirm each one). Run /actions revoke ${authCat2} to disable.\n`)
              }
            } catch {}
            try {
              const CHAIN_BREADCRUMBS2: Record<string, string> = {
                chain_calibration:     'Build calibration brief: targeted questions in areas of consistent agent error',
                chain_timing_tracking: 'Add timing pattern tracking to session prep brief',
                chain_goal_alignment:  'Add weekly goal alignment check to session prep brief',
              }
              const breadcrumb2 = CHAIN_BREADCRUMBS2[t2.action.action_category]
              if (breadcrumb2) {
                const { saveInProgress } = await import('./lib/continuity/inprogress.js')
                saveInProgress(btUserId, breadcrumb2, t2.action.insight_text.slice(0, 300), null, null)
                console.log("  ✓ Saved — I'll remind you next session.\n")
              }
            } catch {}
          }
          else if (/\b(later|remind me|defer|not now|come back)\b/i.test(a2)) { r2 = 'deferred'; requeueT2(t2.action.id); console.log("\nGot it, I'll bring it up again.\n") }
          else if (/^(n|no|nah|nope|not really)/.test(a2)) {
            r2 = 'dismissed'; markT2Dismissed(t2.action.id); console.log('\nOkay, noted.\n')
            try {
              const { recordChainBreak } = await import('./lib/action-engine/chain.js')
              if (t2.action.action_category.startsWith('chain_')) {
                recordChainBreak(btUserId, t2.action.action_category)
              }
            } catch {}
          }
          else { r2 = 'engaged'; console.log('\nGot it.\n') }
          recT2(btUserId, t2.action.id, t2.action.action_category, r2, t2.window, t2.score)
          } // judgment2.shouldSurface
        }
      } catch {}
    }
  }

  const handleCommand = async (cmd: string): Promise<void> => {
    const parts = cmd.slice(1).trim().split(/\s+/)
    const command = parts[0].toLowerCase()
    const args = parts.slice(1).join(' ')

    // /status works even when the extension isn't connected
    if (command === 'status') {
      const { showStatus } = await import('./lib/status.js')
      await showStatus(CLI_PORT)
      return
    }

    const userId = await ensureConnected((q) => prompt(rl, q))
    if (!userId) return

    switch (command) {
      case 'profile': {
        const sub = args.toLowerCase().trim()
        const profilePromptFn = (q: string) => prompt(rl, q)
        if (!sub || sub === 'setup') {
          await runProfileSetup(profilePromptFn)
        } else if (sub === 'deep_setup') {
          await runDeepRoleSetup(profilePromptFn)
        } else if (sub === 'show') {
          showProfile()
        } else if (sub === 'edit') {
          openProfileInEditor()
        } else if (sub.startsWith('update')) {
          const section = sub.replace('update', '').trim() || ''
          if (!section) {
            console.log('\n  Usage: /profile update <section>')
            console.log('  Sections: identity, voice, platforms, goals, autonomy, domain\n')
          } else {
            await updateProfileSection(section, profilePromptFn)
          }
        } else {
          console.log('\n  /profile setup              — first-time setup (or resume)')
          console.log('  /profile deep_setup         — deep role-specific context (business, writer, etc.)')
          console.log('  /profile show               — view your current profile')
          console.log('  /profile edit               — open USER.md in Notepad to edit directly')
          console.log('  /profile update goals       — update a specific section via prompts')
          console.log('  Sections: identity, voice, platforms, goals, autonomy, domain\n')
        }
        break
      }
      case 'context': {
        const ctxSub = args.trim()

        if (!ctxSub || ctxSub === 'list') {
          const files = listContextFiles()
          const tasks = listActiveTasks()
          const line = '─'.repeat(55)
          console.log(`\n${line}`)
          console.log('  CONTEXT FILES')
          console.log(line)
          if (!files.length) {
            console.log('  No platform context files yet.')
            console.log('  They are created automatically after your 3rd task on a platform.')
          } else {
            files.forEach(f => console.log(`  ${f.platform}.md  (${f.chars} chars)`))
          }
          if (tasks.length) {
            console.log(`\n  Active tasks (${tasks.length}):`)
            tasks.forEach(t => console.log(`  [in_progress] ${t.goal}`))
          }
          console.log(`\n  /context show <platform>  — view a context file`)
          console.log(`  /context edit <platform>  — edit in Notepad`)
          console.log(line + '\n')

        } else if (ctxSub.startsWith('show ')) {
          const platform = ctxSub.slice(5).trim().toLowerCase()
          const content = loadContextFile(platform)
          const line = '─'.repeat(55)
          console.log(`\n${line}`)
          console.log(`  ${platform}.md`)
          console.log(line)
          if (!content) {
            console.log(`  No context file for "${platform}" yet.`)
          } else {
            console.log(content.split('\n').map(l => '  ' + l).join('\n'))
          }
          console.log(line + '\n')

        } else if (ctxSub.startsWith('edit ')) {
          const platform = ctxSub.slice(5).trim().toLowerCase()
          const { execSync } = await import('child_process')
          const filePath = contextFilePath(platform)
          if (!fs.existsSync(filePath)) {
            console.log(`\n  No context file for "${platform}". Run a ${platform} task first or create it manually.\n`)
            break
          }
          try {
            if (process.platform === 'win32') {
              execSync(`start notepad "${filePath}"`, { stdio: 'ignore' })
            } else {
              const editor = process.env.EDITOR || 'nano'
              execSync(`${editor} "${filePath}"`)
            }
            console.log(`\n  Opened ${platform}.md in editor. Changes take effect on the next task.\n`)
          } catch {
            console.log(`\n  Edit directly at: ${filePath}\n`)
          }

        } else if (ctxSub === 'tasks') {
          const tasks = listActiveTasks()
          const line = '─'.repeat(55)
          console.log(`\n${line}`)
          console.log('  ACTIVE TASKS')
          console.log(line)
          if (!tasks.length) {
            console.log('  No active tasks in progress.')
          } else {
            tasks.forEach((t, i) => {
              console.log(`\n  [${i + 1}] ${t.goal}`)
              console.log(`       Started: ${t.created.split('T')[0]}`)
            })
          }
          console.log(line + '\n')

        } else {
          console.log('\n  /context               — list all context files')
          console.log('  /context show <name>   — view a platform context file')
          console.log('  /context edit <name>   — open in Notepad to edit')
          console.log('  /context tasks         — list active in-progress tasks\n')
        }
        break
      }
      case 'memory': {
        const memSub = args.trim()

        if (!memSub || memSub === 'show') {
          const raw = loadMemoryMd()
          const line = '─'.repeat(55)
          const capacity = getCapacityPercent()
          console.log(`\n${line}`)
          console.log(`  MEMORY.md  (${capacity}% of ${MEMORY_MAX_CHARS} chars used)`)
          console.log(line)
          if (!raw || raw.trim() === '') {
            console.log('  Empty — memory builds up automatically after tasks complete.')
          } else {
            const stats = getMemoryStats()
            stats.forEach(s => {
              if (s.lines > 0) console.log(`  [${s.section}] — ${s.lines} entries, ${s.chars} chars`)
            })
            console.log()
            console.log(raw.split('\n').map(l => '  ' + l).join('\n'))
          }
          console.log(line + '\n')

        } else if (memSub === 'pending') {
          const pending = getPendingMemory()
          const line = '─'.repeat(55)
          if (!pending.length) {
            console.log('\n  No pending memory updates.\n')
          } else {
            console.log(`\n${line}`)
            console.log(`  PENDING MEMORY UPDATES (${pending.length})`)
            console.log(line)
            pending.forEach((p: any, i: number) => {
              console.log(`\n  [${i + 1}] ID: ${p.id.slice(0, 8)}...`)
              console.log(`       Section: ${p.section}`)
              console.log(`       Reason: ${p.reason}`)
              console.log(`       Entry: ${p.proposed_entry.slice(0, 120)}`)
            })
            console.log(`\n${line}`)
            console.log('  /memory approve    — approve all')
            console.log('  /memory approve <id prefix> — approve one')
            console.log('  /memory dismiss <id prefix> — dismiss one')
            console.log(line + '\n')
          }

        } else if (memSub === 'approve') {
          const pending = getPendingMemory()
          if (!pending.length) { console.log('\n  No pending updates.\n'); break }
          pending.forEach((p: any) => approvePendingEntry(p.id))
          const profileCount = pending.filter((p: any) => p.section === 'USER_PROFILE').length
          const memCount = pending.length - profileCount
          const parts = []
          if (memCount > 0) parts.push(`${memCount} to MEMORY.md`)
          if (profileCount > 0) parts.push(`${profileCount} to your profile`)
          console.log(`\n  ✓ ${pending.length} update${pending.length > 1 ? 's' : ''} approved (${parts.join(', ')}).\n`)

        } else if (memSub.startsWith('approve ')) {
          const prefix = memSub.slice(8).trim()
          const pending = getPendingMemory()
          const match = pending.find((p: any) => p.id.startsWith(prefix))
          if (!match) { console.log(`\n  No pending entry matching "${prefix}".\n`); break }
          approvePendingEntry(match.id)
          console.log(`\n  ✓ Approved: ${match.section} — ${match.proposed_entry.slice(0, 60)}\n`)

        } else if (memSub.startsWith('dismiss ')) {
          const prefix = memSub.slice(8).trim()
          const pending = getPendingMemory()
          const match = pending.find((p: any) => p.id.startsWith(prefix))
          if (!match) { console.log(`\n  No pending entry matching "${prefix}".\n`); break }
          dismissPendingEntry(match.id)
          console.log(`\n  Dismissed.\n`)

        } else if (memSub.startsWith('search ')) {
          const query = memSub.slice(7).trim()
          if (!query) { console.log('\n  Usage: /memory search <query>\n'); break }
          const results = searchSessions(query)
          const line = '─'.repeat(55)
          if (!results.length) {
            console.log(`\n  No sessions found matching "${query}".\n`)
          } else {
            console.log(`\n${line}`)
            console.log(`  SESSION SEARCH: "${query}"`)
            console.log(line)
            results.forEach((r: any, i: number) => {
              const date = (r.created_at || '?').split('T')[0]
              console.log(`\n  [${i + 1}] ${date}`)
              console.log(`       Task: ${r.task_prompt.slice(0, 80)}`)
              if (r.task_summary) console.log(`       Summary: ${r.task_summary.slice(0, 100)}`)
            })
            console.log(`\n${line}\n`)
          }

        } else {
          console.log('\n  /memory            — show MEMORY.md with section breakdown')
          console.log('  /memory pending    — show staged memory writes waiting approval')
          console.log('  /memory approve    — approve all pending writes')
          console.log('  /memory search <q> — search session history\n')
        }
        break
      }
      case 'soul': {
        const soulSub = args.toLowerCase().trim()
        const soulPromptFn = (q: string) => prompt(rl, q)
        if (!soulSub || soulSub === 'show') {
          showSoul()
        } else if (soulSub === 'setup') {
          await runSoulSetup(soulPromptFn)
        } else if (soulSub === 'edit') {
          openSoulInEditor()
        } else {
          console.log('\n  /soul         — view current personality (SOUL.md)')
          console.log('  /soul setup   — 3-question guided setup')
          console.log('  /soul edit    — open SOUL.md in Notepad to edit directly\n')
        }
        break
      }
      case 'followups':
      case 'followup': {
        const fuSub = args.trim().toLowerCase()
        const fuUserId = getConnectedUserId() || 'local'
        const line = '─'.repeat(55)

        if (!fuSub || fuSub === 'list') {
          const items = getOpenItems(fuUserId)
          const overdue = getOverdueOpenItems(fuUserId)
          console.log(`\n${line}`)
          console.log('  OPEN THREADS')
          console.log(line)
          if (!items.length) {
            console.log('  No open threads. They appear when you send emails, pitch to investors, etc.')
          } else {
            items.forEach((item, i) => {
              const days = daysSince(item.opened_at)
              const daysLabel = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
              const overdueMark = overdue.some(o => o.id === item.id) ? ' ⏰' : ''
              console.log(`  ${i + 1}. [${item.id.slice(0, 6)}] ${item.summary}${overdueMark}`)
              if (item.related_person) console.log(`        Person: ${item.related_person}`)
              if (item.context) console.log(`        Context: ${item.context}`)
              console.log(`        Opened: ${daysLabel}`)
            })
            console.log(`\n  /followups resolve <keyword>  — mark matching item resolved`)
            console.log(`  /followups dismiss <id>       — remove an item`)
          }
          console.log(line + '\n')

        } else if (fuSub.startsWith('resolve ')) {
          const keyword = args.trim().slice('resolve '.length).trim()
          if (!keyword) { console.log('\n  Usage: /followups resolve <keyword>\n'); break }
          const count = resolveByKeyword(fuUserId, keyword)
          if (count > 0) {
            console.log(`\n  ✓ Resolved ${count} thread${count > 1 ? 's' : ''} matching "${keyword}".\n`)
          } else {
            console.log(`\n  No open threads matching "${keyword}".\n`)
          }

        } else if (fuSub.startsWith('dismiss ')) {
          const idPrefix = args.trim().slice('dismiss '.length).trim()
          const items = getOpenItems(fuUserId)
          const match = items.find(i => i.id.startsWith(idPrefix))
          if (!match) { console.log(`\n  No open item starting with "${idPrefix}".\n`); break }
          dismissItem(match.id)
          console.log(`\n  Dismissed: "${match.summary}"\n`)

        } else {
          console.log('\n  /followups             — list open threads')
          console.log('  /followups resolve <keyword> — mark matching thread resolved')
          console.log('  /followups dismiss <id>      — remove a thread\n')
        }
        break
      }

      case 'actions': {
        const actSub = args.trim().toLowerCase()
        const actUserId = getConnectedUserId() || 'local'
        const { showActionsLog, showActionsPending, handleActionsStop, handleActionsResume, handleActionsWhy, handleActionsAuthorize, handleActionsRevoke, showAuthorizations, handleActionsPull, handleActionsPush } = await import('./lib/action-engine/actions-commands.js')
        if (!actSub || actSub === 'show') {
          showActionsLog(actUserId)
        } else if (actSub === 'pending') {
          showActionsPending(actUserId)
        } else if (actSub.startsWith('stop ') || actSub === 'stop') {
          handleActionsStop(actUserId, args.trim().slice('stop'.length).trim())
        } else if (actSub.startsWith('resume ') || actSub === 'resume') {
          handleActionsResume(actUserId, args.trim().slice('resume'.length).trim())
        } else if (actSub.startsWith('why ') || actSub === 'why') {
          handleActionsWhy(actUserId, args.trim().slice('why'.length).trim())
        } else if (actSub.startsWith('authorize ') || actSub === 'authorize') {
          handleActionsAuthorize(actUserId, args.trim().slice('authorize'.length).trim())
        } else if (actSub.startsWith('revoke ') || actSub === 'revoke') {
          handleActionsRevoke(actUserId, args.trim().slice('revoke'.length).trim())
        } else if (actSub === 'authorized') {
          showAuthorizations(actUserId)
        } else if (actSub.startsWith('pull ') || actSub === 'pull') {
          handleActionsPull(actUserId, args.trim().slice('pull'.length).trim())
        } else if (actSub.startsWith('push ') || actSub === 'push') {
          handleActionsPush(actUserId, args.trim().slice('push'.length).trim())
        } else {
          console.log('\n  /actions show               — log of what was surfaced and outcomes')
          console.log('  /actions pending            — what\'s queued and why it hasn\'t surfaced')
          console.log('  /actions why <id>           — score breakdown for a queued item')
          console.log('  /actions stop <cat>         — suppress a category')
          console.log('  /actions stop all           — silence all proactive items')
          console.log('  /actions resume <cat>       — re-enable a suppressed category')
          console.log('  /actions authorize <cat>    — enable autonomous execution for a category')
          console.log('  /actions authorized          — show active autonomous authorizations')
          console.log('  /actions revoke <cat>       — disable autonomous execution')
          console.log('  /actions pull <id>          — force an item to Tier 1 at next session')
          console.log('  /actions push <id> in N days — delay an item by N days\n')
        }
        break
      }

      case 'commitments': {
        const cmtSub = args.trim()
        const cmtUserId = getConnectedUserId() || 'local'
        const { createCommitment, listCommitments, cancelCommitment: cancelCmt, parseCommitmentInput } = await import('./lib/continuity/commitments.js')
        const LINE_CMT = '─'.repeat(55)

        if (!cmtSub || cmtSub.toLowerCase() === 'list') {
          const all = listCommitments(cmtUserId)
          console.log(`\n${LINE_CMT}`)
          console.log('  COMMITMENTS')
          console.log(LINE_CMT)
          if (!all.length) {
            console.log('  No pending commitments.')
            console.log('  Create one: /commitments add "description" in 3 days')
            console.log('  Or: /commitments add "description" when fundraising')
          } else {
            for (const c of all) {
              const due = c.due_at ? ` — due ${c.due_at.slice(0, 10)}` : c.trigger_value ? ` — when: ${c.trigger_value}` : ''
              console.log(`  [${c.id.slice(0, 6)}] ${c.description}${due}`)
            }
          }
          console.log(`\n  /commitments add "desc" in N days   — time-based`)
          console.log(`  /commitments add "desc" when [X]    — condition-based`)
          console.log(`  /commitments cancel <id>             — remove one`)
          console.log(LINE_CMT + '\n')
        } else if (cmtSub.toLowerCase().startsWith('add ')) {
          const text = cmtSub.slice(4).trim()
          const parsed = parseCommitmentInput(text)
          // Extract the description (everything before the timing phrase)
          const descMatch = text.match(/^["']?(.+?)["']?\s+(?:in\s+\d+|tomorrow|next week|when\s)/i)
          const description = descMatch ? descMatch[1].trim() : text
          if (!parsed) {
            console.log('\n  Could not parse timing. Try: /commitments add "description" in 3 days\n')
          } else {
            const id = createCommitment(cmtUserId, parsed.type, description, parsed.triggerType, parsed.triggerValue, null)
            const dueInfo = parsed.triggerType === 'after_N_days' ? `in ${parsed.triggerValue} days` : `when: ${parsed.triggerValue}`
            console.log(`\n  ✓ Commitment tracked [${id.slice(0, 6)}]: "${description}" — ${dueInfo}\n`)
          }
        } else if (cmtSub.toLowerCase().startsWith('cancel ')) {
          const idPrefix = cmtSub.slice(7).trim()
          const all = listCommitments(cmtUserId)
          const match = all.find(c => c.id.startsWith(idPrefix))
          if (!match) {
            console.log(`\n  No commitment found starting with "${idPrefix}"\n`)
          } else {
            cancelCmt(match.id)
            console.log(`\n  Cancelled: "${match.description}"\n`)
          }
        } else {
          console.log('\n  /commitments list                    — see all pending')
          console.log('  /commitments add "desc" in N days   — time-based commitment')
          console.log('  /commitments add "desc" when [X]    — condition-based commitment')
          console.log('  /commitments cancel <id>             — cancel a commitment\n')
        }
        break
      }

      case 'inprogress': {
        const iptSub = args.trim().toLowerCase()
        const iptUserId = getConnectedUserId() || 'local'
        const { getAllActiveInProgress, resolveInProgress: resolveIPT, abandonInProgress: abandonIPT } = await import('./lib/continuity/inprogress.js')
        const LINE_IPT = '─'.repeat(55)

        if (!iptSub || iptSub === 'list') {
          const all = getAllActiveInProgress(iptUserId)
          console.log(`\n${LINE_IPT}`)
          console.log('  IN-PROGRESS TASKS')
          console.log(LINE_IPT)
          if (!all.length) {
            console.log('  No in-progress tasks tracked.')
            console.log('  The agent saves these automatically when you continue work across sessions.')
          } else {
            for (const t of all) {
              const daysAgo = Math.floor((Date.now() - new Date(t.last_session_at).getTime()) / 86400000)
              const when = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`
              console.log(`  [${t.id.slice(0, 6)}] ${t.task_description.slice(0, 70)}`)
              console.log(`         last: ${when}${t.next_steps ? ` | next: ${t.next_steps.slice(0, 60)}` : ''}`)
            }
          }
          console.log(`\n  /inprogress done <id>    — mark completed`)
          console.log(`  /inprogress drop <id>    — abandon (no longer needed)`)
          console.log(LINE_IPT + '\n')
        } else if (iptSub.startsWith('done ')) {
          const idPrefix = iptSub.slice(5).trim()
          const all = getAllActiveInProgress(iptUserId)
          const match = all.find(t => t.id.startsWith(idPrefix))
          if (!match) { console.log(`\n  No task found starting with "${idPrefix}"\n`) }
          else { resolveIPT(match.id); console.log(`\n  ✓ Marked complete: "${match.task_description.slice(0, 60)}"\n`) }
        } else if (iptSub.startsWith('drop ')) {
          const idPrefix = iptSub.slice(5).trim()
          const all = getAllActiveInProgress(iptUserId)
          const match = all.find(t => t.id.startsWith(idPrefix))
          if (!match) { console.log(`\n  No task found starting with "${idPrefix}"\n`) }
          else { abandonIPT(match.id); console.log(`\n  Cleared: "${match.task_description.slice(0, 60)}"\n`) }
        } else {
          console.log('\n  /inprogress list          — see all in-progress tasks')
          console.log('  /inprogress done <id>     — mark completed')
          console.log('  /inprogress drop <id>     — abandon\n')
        }
        break
      }

      case 'suggestions': {
        const suggSub = args.trim().toLowerCase()
        const line = '─'.repeat(55)

        if (!suggSub || suggSub === 'list') {
          const suggestions = loadSuggestions()
          console.log(`\n${line}`)
          console.log('  AUTOMATION SUGGESTIONS')
          console.log(line)
          if (!suggestions.length) {
            console.log('  No suggestions yet. They appear when you repeat tasks 3+ times.')
          } else {
            suggestions.forEach((s, i) => {
              console.log(`  ${i + 1}. [${s.id}] ${s.date}`)
              console.log(`     ${s.text}`)
              console.log(`     (${s.trigger})`)
            })
            console.log(`\n  /suggestions dismiss <n>  — archive suggestion #n`)
            console.log(`  /suggestions done <n>     — mark as acted on`)
          }
          console.log(line + '\n')

        } else if (suggSub.startsWith('dismiss ') || suggSub.startsWith('done ')) {
          const numStr = suggSub.split(/\s+/)[1]
          const num = parseInt(numStr)
          const suggestions = loadSuggestions()
          if (isNaN(num) || num < 1 || num > suggestions.length) {
            console.log(`\n  Invalid number. You have ${suggestions.length} suggestion(s).\n`)
          } else {
            const target = suggestions[num - 1]
            dismissSuggestion(target.id)
            const verb = suggSub.startsWith('done') ? 'Marked done' : 'Dismissed'
            console.log(`\n  ✓ ${verb}: "${target.text.slice(0, 60)}"\n`)
          }

        } else if (suggSub.startsWith('create ')) {
          const numStr = suggSub.split(/\s+/)[1]
          const num = parseInt(numStr)
          const suggestions = loadSuggestions()
          if (isNaN(num) || num < 1 || num > suggestions.length) {
            console.log(`\n  Invalid number. You have ${suggestions.length} suggestion(s).\n`)
          } else {
            const target = suggestions[num - 1]
            dismissSuggestion(target.id)
            console.log(`\n  Starting skill creation for:\n  "${target.text}"\n`)
            await runSkillCreator(rl, userId, target.text)
          }

        } else if (suggSub === 'archive') {
          const archived = loadArchivedSuggestions()
          console.log(`\n${line}`)
          console.log('  ARCHIVED SUGGESTIONS')
          console.log(line)
          if (!archived.length) {
            console.log('  No archived suggestions yet.')
          } else {
            archived.forEach(s => {
              console.log(`  [${s.id}] ${s.date} (archived ${s.archivedDate})`)
              console.log(`     ${s.text}`)
            })
          }
          console.log(line + '\n')

        } else {
          console.log('\n  /suggestions             — list automation suggestions')
          console.log('  /suggestions dismiss <n> — archive suggestion #n')
          console.log('  /suggestions done <n>    — mark as acted on')
          console.log('  /suggestions create <n>  — build a skill from suggestion #n')
          console.log('  /suggestions archive     — view archived suggestions\n')
        }
        break
      }
      case 'skill':
        await runSkillCreator(rl, userId)
        break
      case 'skills':
        listSkills(userId, args.trim() === 'archived')
        break
      case 'drafts':
        await showDrafts(rl, userId)
        break
      case 'proposals':
        await showProposals(rl, userId)
        break
      case 'pin':
        pinSkill(userId, args.trim())
        break
      case 'unpin':
        unpinSkill(userId, args.trim())
        break
      case 'restore':
        restoreArchivedSkill(userId, args.trim())
        break
      case 'run':
        await runSavedSkill(rl, userId, args)
        break
      case 'edit':
        await runSkillEditor(rl, userId, args)
        break
      case 'delete':
        await runSkillDelete(rl, userId, args)
        break
      case 'attach': {
        if (!args) { console.log('Usage: /attach <skill-name>'); break }
        const found = resolveSkillByName(userId, args)
        if (!found) {
          console.log(`  ✗ Skill "${args}" not found. Use /skills to see your saved skills.`)
        } else if (sessionAttachedSkillIds.includes(found.id)) {
          console.log(`  ✓ "${found.skill_name}" is already attached.`)
        } else {
          sessionAttachedSkillIds.push(found.id)
          console.log(`  ✓ "${found.skill_name}" attached — will be used as context for your next task.`)
        }
        break
      }
      case 'detach': {
        if (!args) {
          // Detach all
          sessionAttachedSkillIds.length = 0
          console.log('  All attached skills cleared.')
        } else {
          const found = resolveSkillByName(userId, args)
          if (found) {
            const idx = sessionAttachedSkillIds.indexOf(found.id)
            if (idx !== -1) {
              sessionAttachedSkillIds.splice(idx, 1)
              console.log(`  ✓ "${found.skill_name}" detached.`)
            } else {
              console.log(`  "${found.skill_name}" was not attached.`)
            }
          } else {
            console.log(`  Skill "${args}" not found.`)
          }
        }
        break
      }
      case 'attached': {
        if (!sessionAttachedSkillIds.length) {
          console.log('  No skills attached for the next task.')
        } else {
          console.log(`  Attached skills (${sessionAttachedSkillIds.length}):`)
          for (const id of sessionAttachedSkillIds) {
            const row = resolveSkillByName(userId, id) ?? { skill_name: id }
            console.log(`    • ${row.skill_name}`)
          }
        }
        break
      }
      case 'task':
        if (!args) { console.log('Usage: /task <description>'); break }
        await runTask(args)
        break
      case 'tabs': {
        const tabUserId = await ensureConnected((q) => prompt(rl, q))
        if (!tabUserId) break
        const tabs = await getOpenTabs(tabUserId)
        if (!tabs.length) { console.log('\nNo open tabs found (or extension not responding).\n'); break }
        const line = '─'.repeat(60)
        console.log(`\n${line}`)
        console.log('  OPEN BROWSER TABS')
        console.log(line)
        tabs.filter(t => !t.isSensitive).slice(0, 15).forEach((t, i) => {
          const flags = [t.active ? 'ACTIVE' : '', t.isAttached ? 'ATTACHED' : ''].filter(Boolean).join(', ')
          const url = t.url.slice(0, 70)
          console.log(`  [${i + 1}] Tab ${t.tabId}${flags ? ` (${flags})` : ''}`)
          console.log(`      "${t.title.slice(0, 60)}"`)
          console.log(`      ${url}`)
        })
        console.log(line)
        console.log('  Tip: mention the site name in your task and jarvis will use the existing tab.')
        console.log(`      e.g. "go to Twitter and..." → automatically uses an open Twitter tab\n`)
        break
      }
      case 'permissions': {
        const perms = db.prepare("SELECT * FROM standing_permissions WHERE user_id = ? ORDER BY created_at DESC").all(userId) as any[]
        if (!perms.length) {
          console.log('\n  No standing permissions set.')
          console.log('  After approving the same action 3 times, you\'ll be offered to create one.\n')
        } else {
          console.log(`\n  Standing permissions (${perms.length}):`)
          console.log('  ' + '─'.repeat(55))
          perms.forEach((p, i) => {
            const expires = p.expires_at ? `expires ${p.expires_at}` : 'permanent'
            const label = p.scope_note || `${p.action_type}${p.platform ? ' on ' + p.platform : ''}`
            console.log(`  [${i + 1}] ${label} — ${expires}`)
          })
          console.log('  ' + '─'.repeat(55))
          const spAnswer = (await prompt(rl, '  Enter number to revoke, or Enter to close: > ')).trim()
          const idx = parseInt(spAnswer) - 1
          if (!isNaN(idx) && idx >= 0 && idx < perms.length) {
            db.prepare("DELETE FROM standing_permissions WHERE id = ?").run(perms[idx].id)
            console.log(`  ✓ Revoked: ${perms[idx].scope_note || perms[idx].action_type}`)
          }
          console.log()
        }
        break
      }
      case 'audit': {
        const logs = db.prepare(`
          SELECT * FROM confirmation_audit_log
          WHERE user_id = ?
          ORDER BY decided_at DESC LIMIT 20
        `).all(userId) as any[]
        if (!logs.length) {
          console.log('\n  No confirmation history yet.\n')
        } else {
          console.log(`\n  Last ${logs.length} confirmation events:`)
          console.log('  ' + '─'.repeat(60))
          for (const l of logs) {
            const when = (l.decided_at || '?').split('T')[0]
            const icon = l.decision === 'approved' ? '✓' : l.decision === 'denied' ? '✗' : l.decision === 'timeout' ? '⏱' : '✎'
            const auto = l.via_standing_permission ? ' (auto)' : ''
            console.log(`  ${icon} [${when}] ${l.action_type} — ${l.target}${auto}  [T${l.tier}]`)
            if (l.content_snapshot) {
              const preview = l.content_snapshot.slice(0, 80)
              console.log(`      "${preview}${l.content_snapshot.length > 80 ? '...' : ''}"`)
            }
          }
          console.log('  ' + '─'.repeat(60))
          console.log()
        }
        break
      }
      case 'help':
        console.log('\nAvailable commands:')
        console.log('  /context           — list platform context files')
        console.log('  /context show <p>  — view a platform context file')
        console.log('  /context edit <p>  — edit a platform context file')
        console.log('  /context tasks     — list active in-progress tasks')
        console.log('  /memory            — show MEMORY.md (what Jarvis has learned)')
        console.log('  /memory pending    — show memory updates waiting approval')
        console.log('  /memory approve    — approve all pending memory writes')
        console.log('  /memory search <q> — search session history')
        console.log('  /suggestions       — view automation suggestions')
        console.log('  /soul             — view Jarvis personality (SOUL.md)')
        console.log('  /soul setup       — guided 3-question personality setup')
        console.log('  /soul edit        — open SOUL.md in Notepad to edit directly')
        console.log('  /profile              — set up or update your user profile')
        console.log('  /profile deep_setup   — deep role-specific context (business, writer, etc.)')
        console.log('  /profile show         — view your current profile')
        console.log('  /profile edit         — open USER.md in Notepad to edit directly')
        console.log('  /profile update voice    — re-run voice extraction with new samples')
        console.log('  /profile update <section> — update one section (goals, etc.)')
        console.log('  /skill            — create a new skill')
        console.log('  /skills           — list your saved skills')
        console.log('  /skills archived  — list archived skills')
        console.log('  /drafts           — review new skill drafts (approve / dismiss)')
        console.log('  /proposals        — review improvement proposals (apply / skip)')
        console.log('  /run <name>       — run a saved skill')
        console.log('  /edit <name>      — re-open a saved skill for editing')
        console.log('  /pin <name>       — pin a skill (protects from auto-changes)')
        console.log('  /unpin <name>     — unpin a skill')
        console.log('  /restore <name>   — restore an archived skill')
        console.log('  /<skill-name>     — show skill card; /<name> <task> to run it')
        console.log('  /attach <name>    — attach a skill as context for the next task')
        console.log('  /detach [name]    — detach a skill (or all if no name given)')
        console.log('  /attached         — show currently attached skills')
        console.log('  /compact          — summarize old turns to free up context window')
        console.log('  /task <desc>      — run a task (same as typing it directly)')
        console.log('  /tabs             — list open Chrome tabs (shows what jarvis can see)')
        console.log('  /permissions      — view and revoke standing auto-approvals')
        console.log('  /audit            — show last 20 agent confirmation events')
        console.log('  /missions                      — Mission Mode (multi-division long-horizon tasks)')
        console.log('  /missions launch <goal>        — launch a complex multi-agent mission')
        console.log('  /missions status <id>          — show division + job tree')
        console.log('  /missions watch <id>           — stream live mission progress')
        console.log('  /model show       — show what I know about you (profile + directives + state)')
        console.log('  /correct <text>   — fix something wrong in my model or add a directive')
        console.log('  /explain          — explain why I surfaced the last cross-channel insight')
        console.log('  /help             — show this menu')
        console.log('  exit / quit     — close jarvis')
        console.log('\nOr just type any task directly without a slash.')
        console.log('Jarvis will suggest relevant skills before starting if any are found.\n')
        break
      case 'model': {
        const modelUserId = getConnectedUserId() || (db.prepare('SELECT user_id FROM api_keys LIMIT 1').get() as any)?.user_id || 'local'
        const sub = args.toLowerCase().trim()
        if (!sub || sub === 'show') {
          const line = '─'.repeat(55)
          console.log(`\n${line}\n  WHAT I KNOW ABOUT YOU\n${line}`)

          // Behavioral contract
          try {
            const { getActiveDirectives } = await import('./lib/behavioral-contract/detector.js')
            const directives = getActiveDirectives(modelUserId)
            if (directives.length > 0) {
              console.log('\n[Explicit preferences you\'ve stated]')
              directives.forEach(d => console.log(`  • ${d.directive_value}`))
            } else {
              console.log('\n[Explicit preferences] — none recorded yet')
            }
          } catch {}

          // Channel A — language profile
          try {
            const aProf = db.prepare('SELECT * FROM channel_a_profiles WHERE user_id = ?').get(modelUserId) as any
            console.log('\n[Language & communication style]')
            if (aProf) {
              const tribe = JSON.parse(aProf.vocabulary_tribe || '{}')
              console.log(`  Vocabulary tribe: ${tribe.primary_tribe ?? 'not determined yet'} (${aProf.total_samples ?? 0} samples)`)
              const hedging = JSON.parse(aProf.hedging_profile || '{}')
              const rate = Math.round((hedging.overall_hedging_rate || 0) * 100)
              if (rate > 0) console.log(`  Hedging rate: ${rate}% (${rate > 30 ? 'high — tends to qualify statements' : rate < 10 ? 'low — direct communicator' : 'moderate'})`)
              const frust = JSON.parse(aProf.frustration_fingerprint || '{}')
              if (frust.frustration_count_last_30_days > 0) console.log(`  Frustration signals (30d): ${frust.frustration_count_last_30_days}`)
            } else { console.log('  Not enough data yet (need 5+ messages)') }
          } catch {}

          // Channel K — cognitive state
          try {
            const kProf = db.prepare('SELECT * FROM channel_k_profiles WHERE user_id = ?').get(modelUserId) as any
            console.log('\n[Current cognitive state]')
            if (kProf && kProf.total_messages >= 3) {
              console.log(`  Energy: ${kProf.energy_state ?? 'unknown'}, Confidence: ${kProf.confidence_level ?? 'unknown'}`)
              console.log(`  Avg message length: ${Math.round(kProf.avg_message_length ?? 0)} chars (${kProf.total_messages} messages total)`)
            } else { console.log('  Not enough data yet') }
          } catch {}

          // Channel B — correction patterns
          try {
            const bProf = db.prepare('SELECT * FROM channel_b_profiles WHERE user_id = ?').get(modelUserId) as any
            if (bProf && bProf.total_reactions > 0) {
              const corrProf = JSON.parse(bProf.correction_profile || '{}')
              const highTypes: string[] = corrProf.high_correction_types ?? []
              console.log('\n[Correction patterns]')
              console.log(`  Total reactions on record: ${bProf.total_reactions}`)
              if (highTypes.length > 0) console.log(`  High-correction task types: ${highTypes.join(', ')}`)
            }
          } catch {}

          // Channel M — vocabulary drift
          try {
            const mProf = db.prepare('SELECT * FROM channel_m_profiles WHERE user_id = ?').get(modelUserId) as any
            if (mProf && mProf.total_distinct_words >= 5) {
              console.log('\n[Vocabulary & domain drift]')
              console.log(`  Direction: ${mProf.drift_direction ?? 'not yet determined'}`)
              console.log(`  Distinct tracked words: ${mProf.total_distinct_words}`)
            }
          } catch {}

          // Channel F — relationships
          try {
            const rels = db.prepare(`
              SELECT name, mention_count, trajectory, register, is_bridge
              FROM channel_f_relationship_profiles WHERE user_id = ?
              ORDER BY mention_count DESC LIMIT 5
            `).all(modelUserId) as any[]
            if (rels.length > 0) {
              console.log('\n[Key relationships]')
              rels.forEach(r => {
                const tags = [r.trajectory, r.register, r.is_bridge ? 'bridge' : ''].filter(Boolean).join(', ')
                console.log(`  ${r.name} — ${r.mention_count} mentions${tags ? ` (${tags})` : ''}`)
              })
            }
          } catch {}

          // Channel O — achievements
          try {
            const oProf = db.prepare('SELECT * FROM channel_o_profiles WHERE user_id = ?').get(modelUserId) as any
            if (oProf && oProf.total_achievements > 0) {
              console.log('\n[Achievements on record]')
              console.log(`  Total: ${oProf.total_achievements}`)
              const recent = db.prepare(`
                SELECT achievement_type, achievement_description FROM channel_o_achievements
                WHERE user_id = ? ORDER BY achieved_at DESC LIMIT 3
              `).all(modelUserId) as any[]
              recent.forEach(a => console.log(`  • [${a.achievement_type}] ${a.achievement_description.slice(0, 80)}`))
            }
          } catch {}

          // Channel I — decision style
          try {
            const iProf = db.prepare('SELECT * FROM channel_i_profiles WHERE user_id = ?').get(modelUserId) as any
            if (iProf && iProf.total_signals >= 3) {
              console.log('\n[Decision style]')
              if (iProf.dominant_style) console.log(`  Pattern: ${iProf.dominant_style}`)
            }
          } catch {}

          // Channel L — avoidance
          try {
            const lProf = db.prepare('SELECT * FROM channel_l_profiles WHERE user_id = ?').get(modelUserId) as any
            if (lProf && lProf.total_signals >= 2) {
              console.log('\n[Avoidance patterns]')
              if (lProf.dominant_resistance) console.log(`  Primary avoidance type: ${lProf.dominant_resistance}`)
              console.log(`  Avoidance signals on record: ${lProf.total_signals}`)
            }
          } catch {}

          // Live state
          try {
            const ls = db.prepare('SELECT * FROM live_state WHERE user_id = ?').get(modelUserId) as any
            if (ls) {
              console.log('\n[Current session state]')
              console.log(`  Intent: ${ls.session_intent}, Urgency: ${ls.urgency_level}, Load: ${ls.cognitive_load}`)
              console.log(`  Emotional temperature: ${ls.emotional_temperature}`)
              if (ls.current_focus_topic) console.log(`  Active topic: ${ls.current_focus_topic}`)
            }
          } catch {}

          // Synthesis state
          try {
            const sRows = db.prepare('SELECT * FROM synthesis_state WHERE user_id = ?').all(modelUserId) as any[]
            if (sRows.length > 0) {
              console.log('\n[Cross-channel synthesis]')
              sRows.forEach(r => {
                if (r.last_value) console.log(`  ${r.synthesis_type}: ${r.last_value} (surfaced ${r.last_surfaced_at?.slice(0, 10)})`)
              })
            }
          } catch {}

          console.log(`\n${line}`)
          console.log('Use /correct <correction> to fix anything wrong.')
          console.log('Use /explain to understand the last insight I surfaced.\n')
        } else {
          console.log('\n  /model show   — show everything I know about you\n')
        }
        break
      }

      case 'correct': {
        const modelUserId = getConnectedUserId() || (db.prepare('SELECT user_id FROM api_keys LIMIT 1').get() as any)?.user_id || 'local'
        if (!args.trim()) {
          console.log('\n  Usage: /correct <correction>')
          console.log('  Examples:')
          console.log('    /correct always give me bullet points for research')
          console.log('    /correct my current focus is product, not fundraising')
          console.log('    /correct never suggest I reach out to John')
          console.log('    /correct remove directive: always give me bullet points\n')
          break
        }
        const corrText = args.trim()

        // Revoke if user says "remove" or "revoke"
        if (/^(remove|revoke|delete|cancel)\s+(directive|rule|preference):?\s+/i.test(corrText)) {
          try {
            const { getActiveDirectives, revokeDirective } = await import('./lib/behavioral-contract/detector.js')
            const toRemove = corrText.replace(/^(remove|revoke|delete|cancel)\s+(directive|rule|preference):?\s+/i, '').toLowerCase()
            const directives = getActiveDirectives(modelUserId)
            const match = directives.find(d => d.directive_value.toLowerCase().includes(toRemove))
            if (match) {
              revokeDirective(match.id)
              console.log(`\n✅ Removed directive: "${match.directive_value}"\n`)
            } else {
              console.log(`\n⚠️  No matching directive found for "${toRemove}". Use /model show to see current directives.\n`)
            }
          } catch { console.log('\n❌ Could not process removal.\n') }
          break
        }

        // Check if it's a directive (always/never/from now on pattern)
        const isDirective = /\b(always|never|from now on|every time|don'?t ever|stop)\b/i.test(corrText)
        if (isDirective) {
          try {
            const { addExplicitDirective } = await import('./lib/behavioral-contract/detector.js')
            addExplicitDirective(modelUserId, corrText)
            console.log(`\n✅ Saved as permanent preference: "${corrText}"\n`)
          } catch { console.log('\n❌ Could not save directive.\n') }
        } else {
          // Treat as a one-time model correction — store with low polarity
          try {
            const { addExplicitDirective } = await import('./lib/behavioral-contract/detector.js')
            addExplicitDirective(modelUserId, corrText, 'manual_correction')
            console.log(`\n✅ Noted: "${corrText}". This will inform my next responses.\n`)
          } catch { console.log('\n❌ Could not save correction.\n') }
        }
        break
      }

      case 'explain': {
        const modelUserId = getConnectedUserId() || (db.prepare('SELECT user_id FROM api_keys LIMIT 1').get() as any)?.user_id || 'local'
        try {
          const sRows = db.prepare(`
            SELECT synthesis_type, last_value, last_surfaced_at FROM synthesis_state
            WHERE user_id = ? AND last_surfaced_at IS NOT NULL
            ORDER BY last_surfaced_at DESC LIMIT 1
          `).all(modelUserId) as any[]

          if (sRows.length === 0) {
            console.log('\nNo cross-channel insights have been surfaced yet. Keep using the CLI and check back after a few more sessions.\n')
            break
          }

          const last = sRows[0]
          const line = '─'.repeat(55)
          console.log(`\n${line}\n  WHY I SAID THAT\n${line}`)
          console.log(`\nLast insight surfaced: [${last.synthesis_type}] "${last.last_value}" on ${last.last_surfaced_at?.slice(0, 10)}\n`)

          const explanations: Record<string, () => string> = {
            's1': () => {
              const votes: string[] = []
              try {
                const aProf = db.prepare('SELECT vocabulary_tribe FROM channel_a_profiles WHERE user_id = ?').get(modelUserId) as any
                if (aProf) { const t = JSON.parse(aProf.vocabulary_tribe || '{}'); if (t.primary_tribe) votes.push(`Channel A vocabulary tribe → ${t.primary_tribe}`) }
              } catch {}
              try {
                const mProf = db.prepare('SELECT drift_direction FROM channel_m_profiles WHERE user_id = ?').get(modelUserId) as any
                if (mProf?.drift_direction) votes.push(`Channel M vocabulary drift → ${mProf.drift_direction}`)
              } catch {}
              return `Focus convergence: multiple channels pointed to the same dominant focus area.\nSignals:\n${votes.map(v => `  • ${v}`).join('\n') || '  (channels building up — check back soon)'}`
            },
            's2': () => {
              const dims: string[] = []
              try {
                const k = db.prepare('SELECT energy_state FROM channel_k_profiles WHERE user_id = ?').get(modelUserId) as any
                if (k?.energy_state === 'depleted' || k?.energy_state === 'low') dims.push(`Channel K: energy = ${k.energy_state}`)
                const overload = (db.prepare("SELECT COUNT(*) AS cnt FROM channel_k_signals WHERE user_id = ? AND signal_type = 'overload' AND created_at >= datetime('now', '-24 hours')").get(modelUserId) as any)?.cnt
                if (overload >= 2) dims.push(`Channel K: ${overload} overload signals in 24h`)
                const frust = (db.prepare("SELECT COUNT(*) AS cnt FROM channel_a_raw_signals WHERE user_id = ? AND frustration_detected = 1 AND created_at >= datetime('now', '-24 hours')").get(modelUserId) as any)?.cnt
                if (frust >= 2) dims.push(`Channel A: ${frust} frustration signals in 24h`)
              } catch {}
              return `Stress composite: ${dims.length}/7 dimensions active.\nActive signals:\n${dims.map(d => `  • ${d}`).join('\n') || '  (building baseline — need more sessions)'}`
            },
            's3': () => `Relationship importance: Channel F has tracked enough mentions and trajectory data to flag these as high-importance contacts.`,
            's4': () => {
              try {
                const mProf = db.prepare('SELECT drift_direction FROM channel_m_profiles WHERE user_id = ?').get(modelUserId) as any
                const topTask = db.prepare(`SELECT task_category, COUNT(*) as cnt FROM channel_g_task_snapshots WHERE user_id = ? GROUP BY task_category ORDER BY cnt DESC LIMIT 1`).get(modelUserId) as any
                return `Goal drift: stated focus (Channel A/M: ${mProf?.drift_direction ?? 'unknown'}) diverges from actual task pattern (Channel G: ${topTask?.task_category ?? 'unknown'}).`
              } catch { return 'Goal drift: stated vs actual focus diverged significantly over the last 30 days.' }
            },
            's5': () => `Automation opportunity: Channel G found a task type repeating 3+ times with a low correction rate — candidate for a skill or template.`,
          }

          const explain = explanations[last.synthesis_type]
          if (explain) {
            console.log(explain())
          } else {
            console.log(`Insight type: ${last.synthesis_type}\nValue: ${last.last_value}`)
          }

          console.log(`\n${line}\n`)
        } catch (e: any) {
          console.log(`\n❌ Could not load explanation: ${e.message}\n`)
        }
        break
      }

      case 'config': {
        const { handleConfigCommand } = await import('./lib/user-config.js')
        handleConfigCommand(args.trim())
        // If an API key changed, flush the model-router cache so next call re-resolves
        if (/^set\s+(openai|xai|anthropic)_api_key\b/.test(args.trim())) invalidateRuntime()
        break
      }

      case 'compact': {
        if (!_currentCliSessionId) {
          console.log('\n  No active session to compact.\n')
          break
        }
        const { compactSessionTurns } = await import('./lib/session-manager.js')
        console.log('\n  Compacting conversation history...')
        const compactResult = await compactSessionTurns(_currentCliSessionId)
        if (!compactResult) {
          console.log('  Not enough turns yet (need at least 8). Keep chatting!\n')
          break
        }
        // Rebuild in-memory history from the new DB state so the next task uses the compacted window
        const freshTurns = loadSessionTurns(_currentCliSessionId, 200)
        _sessionMessages = freshTurns.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content }))
        if (_sessionMessages.length > 20) _sessionMessages = _sessionMessages.slice(-16)
        const kept = compactResult.total - compactResult.compacted
        console.log(`  ✓ Compacted ${compactResult.compacted} turns → 1 summary. ${kept} recent turns preserved verbatim.\n`)
        break
      }

      case 'missions':
      case 'mission':
        await handleMissionsCommand(rl, userId, args, (q) => prompt(rl, q))
        break

      default: {
        // Feature 8: slash command — check if it's a skill slug
        const skill = findSkillBySlug(userId, command)
        if (skill) {
          if (!args.trim()) {
            showSkillCard(skill, command)
          } else {
            const enriched = await buildSkillEnrichedTask(rl, skill, args.trim())
            await runTask(enriched)
          }
          break
        }
        console.log(`Unknown command: /${command}. Type /help for available commands.`)
      }
    }
  }

  console.log('Type a task or /help for commands. Type "exit" to quit.')
  console.log('Tip: paste multi-line tasks freely with Ctrl+V — they are captured automatically.\n')

  const loop = async () => {
    const firstLine = await prompt(rl, '> ')
    const trimmedFirst = firstLine.trim()
    if (trimmedFirst === 'exit' || trimmedFirst === 'quit') { rl.close(); return }
    if (!trimmedFirst) { loop(); return }

    let task: string
    if (trimmedFirst.startsWith('/')) {
      task = trimmedFirst
    } else {
      // Paste detection: pasted lines arrive within ~5ms of each other;
      // manually typed lines take >150ms. If nothing arrives in 150ms after
      // the first line, it's a single-line task — submit immediately with no
      // extra prompts. If more lines arrive, collect silently until 150ms
      // of silence, then submit the whole block.
      const lines: string[] = [firstLine]
      let next = await peekLine(rl, 300)
      while (next !== null) {
        lines.push(next)
        next = await peekLine(rl, 300)
      }
      // Capture any content sitting in readline's internal buffer — this happens
      // when the last pasted line lacks a trailing newline and readline hasn't
      // emitted a 'line' event for it yet. Use the public rl.line getter (always string).
      const pendingInBuffer = (rl.line ?? '').trim()
      if (pendingInBuffer) {
        lines.push(pendingInBuffer)
      }
      task = lines.join('\n').trim()
    }

    if (task.startsWith('/')) {
      await handleCommand(task).catch(err => console.error('Command error:', err.message))
    } else {
      await runTask(task)
      // Drop the Playwright CDP connection so the "Unclawned is debugging your
      // browser" banner disappears after every task. No-op for local-only tasks.
      await closeAllBrowserConnections().catch(() => {})
    }
    // Discard any input that arrived while the task was running.
    // Without this, trailing annotation lines from a pasted test block
    // (e.g. "> Hits: write_file...") would auto-fire as the next task.
    _lineQueue.length = 0
    loop()
  }

  loop()
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
