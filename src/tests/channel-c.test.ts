/**
 * Channel C test suite — run with: npx tsx src/tests/channel-c.test.ts
 *
 * Level 1 — Unit tests (pure logic, no DB, no file system calls)
 *   domain-classifier, file-classifier, env-scanner (classifyProcesses, classifySchedule)
 * Level 2 — Integration tests (real DB) — added in Part 3+
 * Level 3 — Behavioral tests (manual, run against live server)
 */

import assert from 'node:assert/strict'

let pass = 0
let fail = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (err: any) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    fail++
  }
}

// ── DOMAIN CLASSIFIER ─────────────────────────────────────────────────────────
import { extractDomain, classifyDomain } from '../lib/channel-c/domain-classifier.js'

console.log('\nDomain Classifier — extractDomain')

test('strips protocol and path', () => {
  assert.equal(extractDomain('https://github.com/user/repo'), 'github.com')
})
test('strips www. prefix', () => {
  assert.equal(extractDomain('https://www.notion.so/workspace'), 'notion.so')
})
test('keeps meaningful subdomain (app.)', () => {
  assert.equal(extractDomain('https://app.notion.so/workspace/abc?q=1'), 'app.notion.so')
})
test('keeps meaningful subdomain (mail.)', () => {
  assert.equal(extractDomain('https://mail.google.com/mail/u/0/'), 'mail.google.com')
})
test('strips query string', () => {
  assert.equal(extractDomain('https://stackoverflow.com/questions/123?tab=active'), 'stackoverflow.com')
})
test('handles URL without protocol', () => {
  assert.equal(extractDomain('notion.so/workspace'), 'notion.so')
})

console.log('\nDomain Classifier — classifyDomain')

test('notion.so → productivity', () => {
  assert.equal(classifyDomain('notion.so'), 'productivity')
})
test('github.com → dev', () => {
  assert.equal(classifyDomain('github.com'), 'dev')
})
test('figma.com → design', () => {
  assert.equal(classifyDomain('figma.com'), 'design')
})
test('stripe.com → finance', () => {
  assert.equal(classifyDomain('stripe.com'), 'finance')
})
test('gmail.com → communication', () => {
  assert.equal(classifyDomain('gmail.com'), 'communication')
})
test('sheets.google.com → data', () => {
  assert.equal(classifyDomain('sheets.google.com'), 'data')
})
test('medium.com → content', () => {
  assert.equal(classifyDomain('medium.com'), 'content')
})
test('wikipedia.org → research', () => {
  assert.equal(classifyDomain('wikipedia.org'), 'research')
})
test('claude.ai → ai_tools', () => {
  assert.equal(classifyDomain('claude.ai'), 'ai_tools')
})
test('unknown-startup.io → other', () => {
  assert.equal(classifyDomain('unknown-startup.io'), 'other')
})
test('subdomain fallback: app.notion.so → productivity (via notion.so)', () => {
  assert.equal(classifyDomain('app.notion.so'), 'productivity')
})
test('subdomain fallback: app.slack.com → communication (via slack.com)', () => {
  assert.equal(classifyDomain('app.slack.com'), 'communication')
})
test('subdomain fallback: docs.github.com → dev (via github.com)', () => {
  assert.equal(classifyDomain('docs.github.com'), 'dev')
})

// ── FILE CLASSIFIER ───────────────────────────────────────────────────────────
import {
  classifyFileType,
  extractFolderName,
  extractExtension,
  inferWorkType,
} from '../lib/channel-c/file-classifier.js'

console.log('\nFile Classifier — classifyFileType')

test('.xlsx → data', () => assert.equal(classifyFileType('.xlsx'), 'data'))
test('.csv → data',  () => assert.equal(classifyFileType('.csv'),  'data'))
test('.ts → code',   () => assert.equal(classifyFileType('.ts'),   'code'))
test('.js → code',   () => assert.equal(classifyFileType('.js'),   'code'))
test('.py → code',   () => assert.equal(classifyFileType('.py'),   'code'))
test('.pdf → writing',  () => assert.equal(classifyFileType('.pdf'),  'writing'))
test('.docx → writing', () => assert.equal(classifyFileType('.docx'), 'writing'))
test('.md → writing',   () => assert.equal(classifyFileType('.md'),   'writing'))
test('.fig → design',   () => assert.equal(classifyFileType('.fig'),  'design'))
test('.psd → design',   () => assert.equal(classifyFileType('.psd'),  'design'))
test('.pptx → presentation', () => assert.equal(classifyFileType('.pptx'), 'presentation'))
test('.env → config',   () => assert.equal(classifyFileType('.env'),  'config'))
test('.zip → archive',  () => assert.equal(classifyFileType('.zip'),  'archive'))
test('.unknown → other', () => assert.equal(classifyFileType('.xyz'), 'other'))
test('without dot: ts → code (auto-adds dot)', () => assert.equal(classifyFileType('ts'), 'code'))

console.log('\nFile Classifier — extractFolderName')

test('Windows path → immediate parent folder', () => {
  assert.equal(
    extractFolderName('C:\\Users\\manol\\Documents\\Projects\\report.xlsx'),
    'Projects'
  )
})
test('Unix path → immediate parent folder', () => {
  assert.equal(
    extractFolderName('/home/user/code/my-app/src/index.ts'),
    'src'
  )
})
test('file only, no folder → empty string', () => {
  assert.equal(extractFolderName('report.xlsx'), '')
})
test('empty string → empty string', () => {
  assert.equal(extractFolderName(''), '')
})

console.log('\nFile Classifier — extractExtension')

test('standard file → .ts', () => {
  assert.equal(extractExtension('/path/to/file.ts'), '.ts')
})
test('Windows path → .xlsx', () => {
  assert.equal(extractExtension('C:\\Users\\file.xlsx'), '.xlsx')
})
test('no extension → empty string', () => {
  assert.equal(extractExtension('/path/to/Makefile'), '')
})
test('hidden file (.gitignore) → empty (dot with no extension)', () => {
  assert.equal(extractExtension('.gitignore'), '')
})

console.log('\nFile Classifier — inferWorkType')

test('code dominant (50%) → developer', () => {
  assert.equal(inferWorkType({ code: 10, data: 5, writing: 5 }), 'developer')
})
test('data dominant (60%) → analyst', () => {
  assert.equal(inferWorkType({ data: 6, writing: 2, code: 2 }), 'analyst')
})
test('writing dominant (70%) → writer', () => {
  assert.equal(inferWorkType({ writing: 7, data: 2, code: 1 }), 'writer')
})
test('design dominant (50%) → designer', () => {
  assert.equal(inferWorkType({ design: 5, writing: 3, code: 2 }), 'designer')
})
test('code + data combined (60%) → developer', () => {
  assert.equal(inferWorkType({ code: 4, data: 4, writing: 2 }), 'developer')
})
test('no clear dominant → mixed', () => {
  assert.equal(inferWorkType({ code: 3, data: 3, writing: 3, design: 3 }), 'mixed')
})
test('empty counts → mixed', () => {
  assert.equal(inferWorkType({}), 'mixed')
})

// ── ENV SCANNER — classifyProcesses ──────────────────────────────────────────
import { classifyProcesses, classifySchedule } from '../lib/channel-c/env-scanner.js'

console.log('\nEnv Scanner — classifyProcesses')

test('code.exe → dev', () => {
  const counts = classifyProcesses(['code'])
  assert.equal(counts['dev'], 1)
})
test('chrome → browser', () => {
  const counts = classifyProcesses(['chrome'])
  assert.equal(counts['browser'], 1)
})
test('slack → communication', () => {
  const counts = classifyProcesses(['slack'])
  assert.equal(counts['communication'], 1)
})
test('figma → design', () => {
  const counts = classifyProcesses(['figma'])
  assert.equal(counts['design'], 1)
})
test('notion → productivity', () => {
  const counts = classifyProcesses(['notion'])
  assert.equal(counts['productivity'], 1)
})
test('.exe suffix stripped: code.exe → dev', () => {
  const counts = classifyProcesses(['code.exe'])
  assert.equal(counts['dev'], 1)
})
test('unknown process (svchost) → not counted', () => {
  const counts = classifyProcesses(['svchost', 'runtimebroker', 'msmpeng'])
  assert.equal(Object.keys(counts).length, 0)
})
test('mixed list: dev + browser + noise', () => {
  const counts = classifyProcesses(['code', 'chrome', 'svchost', 'cursor', 'runtimebroker'])
  assert.equal(counts['dev'], 2, `Expected dev=2, got ${counts['dev']}`)
  assert.equal(counts['browser'], 1)
  assert.ok(!counts['unknown'], 'Noise processes should not appear')
})

console.log('\nEnv Scanner — classifySchedule')

function makeHourDist(peakHour: number, strength = 10): number[] {
  const dist = new Array(24).fill(1)
  dist[peakHour] = strength
  return dist
}

test('peak at 6am → early_bird', () => {
  assert.equal(classifySchedule(makeHourDist(6)), 'early_bird')
})
test('peak at 8am → early_bird', () => {
  assert.equal(classifySchedule(makeHourDist(8)), 'early_bird')
})
test('peak at 10am → standard', () => {
  assert.equal(classifySchedule(makeHourDist(10)), 'standard')
})
test('peak at 14 (2pm) → standard', () => {
  assert.equal(classifySchedule(makeHourDist(14)), 'standard')
})
test('peak at 22 (10pm) → night_owl', () => {
  assert.equal(classifySchedule(makeHourDist(22)), 'night_owl')
})
test('peak at 1am → night_owl', () => {
  assert.equal(classifySchedule(makeHourDist(1)), 'night_owl')
})
test('completely flat distribution → irregular', () => {
  assert.equal(classifySchedule(new Array(24).fill(5)), 'irregular')
})
test('wrong length array → irregular', () => {
  assert.equal(classifySchedule([1, 2, 3]), 'irregular')
})
test('all zeros → irregular', () => {
  assert.equal(classifySchedule(new Array(24).fill(0)), 'irregular')
})

// ── INTEGRATION TESTS (real DB) ───────────────────────────────────────────────
import { db } from '../lib/db.js'
import { extractChannelCSignals } from '../lib/channel-c/extractor.js'
import { ChannelCAccumulator } from '../lib/channel-c/accumulator.js'

const TEST_USER = 'test-channel-c-user'
const TEST_SESSION = 'test-session-channel-c-001'

db.prepare("DELETE FROM channel_c_task_snapshots WHERE user_id = ?").run(TEST_USER)
db.prepare("DELETE FROM channel_c_domain_log WHERE user_id = ?").run(TEST_USER)
db.prepare("DELETE FROM channel_c_profiles WHERE user_id = ?").run(TEST_USER)

async function runAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (err: any) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    fail++
  }
}

console.log('\nIntegration Tests — Signal Insertion')

await runAsync('browser task: snapshot row inserted with domain + categories', async () => {
  await extractChannelCSignals({
    userId: TEST_USER,
    sessionId: TEST_SESSION + '-t1',
    taskType: 'browser',
    domainsVisited: ['notion.so', 'github.com'],
    fileExtensions: [],
    folderNames: [],
    desktopScan: null,
  })

  const row = db.prepare(
    "SELECT * FROM channel_c_task_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER) as any

  assert.ok(row, 'Snapshot row should exist')
  assert.equal(row.task_type, 'browser')
  assert.equal(row.domain_count, 2)
  assert.equal(row.primary_domain, 'notion.so')
  assert.equal(row.is_research_task, 0)

  const cats = JSON.parse(row.domain_categories)
  assert.ok(cats.includes('productivity'), `Expected productivity in categories, got: ${JSON.stringify(cats)}`)
  assert.ok(cats.includes('dev'), `Expected dev in categories, got: ${JSON.stringify(cats)}`)
})

await runAsync('local task: file extensions and folder names stored', async () => {
  await extractChannelCSignals({
    userId: TEST_USER,
    sessionId: TEST_SESSION + '-t2',
    taskType: 'local',
    domainsVisited: [],
    fileExtensions: ['.ts', '.md'],
    folderNames: ['src', 'docs'],
    desktopScan: null,
  })

  const row = db.prepare(
    "SELECT * FROM channel_c_task_snapshots WHERE user_id = ? AND session_id = ?"
  ).get(TEST_USER, TEST_SESSION + '-t2') as any

  assert.ok(row, 'Row should exist')
  assert.equal(row.task_type, 'local')
  assert.equal(row.file_count, 2)

  const exts = JSON.parse(row.file_extensions)
  assert.ok(exts.includes('.ts'), `Expected .ts, got: ${JSON.stringify(exts)}`)
  assert.ok(exts.includes('.md'), `Expected .md, got: ${JSON.stringify(exts)}`)

  const folders = JSON.parse(row.folder_names)
  assert.ok(folders.includes('src'), `Expected src, got: ${JSON.stringify(folders)}`)
})

await runAsync('research task: is_research_task=1, domains logged as research artifacts', async () => {
  await extractChannelCSignals({
    userId: TEST_USER,
    sessionId: TEST_SESSION + '-t3',
    taskType: 'research',
    domainsVisited: ['wikipedia.org', 'reddit.com'],
    fileExtensions: [],
    folderNames: [],
    desktopScan: null,
  })

  const row = db.prepare(
    "SELECT is_research_task FROM channel_c_task_snapshots WHERE user_id = ? AND session_id = ?"
  ).get(TEST_USER, TEST_SESSION + '-t3') as any

  assert.equal(row.is_research_task, 1)

  const domainLog = db.prepare(
    "SELECT is_research_artifact FROM channel_c_domain_log WHERE user_id = ? AND domain = 'wikipedia.org' ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER) as any

  assert.ok(domainLog, 'Domain log row should exist')
  assert.equal(domainLog.is_research_artifact, 1, 'Research task domains should be flagged as research artifacts')
})

await runAsync('domain log: each domain gets its own row with correct category', async () => {
  await extractChannelCSignals({
    userId: TEST_USER,
    sessionId: TEST_SESSION + '-t4',
    taskType: 'browser',
    domainsVisited: ['stripe.com', 'figma.com'],
    fileExtensions: [],
    folderNames: [],
    desktopScan: null,
  })

  const stripeLog = db.prepare(
    "SELECT domain_category FROM channel_c_domain_log WHERE user_id = ? AND domain = 'stripe.com' ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER) as any
  assert.equal(stripeLog?.domain_category, 'finance', `Expected finance, got ${stripeLog?.domain_category}`)

  const figmaLog = db.prepare(
    "SELECT domain_category FROM channel_c_domain_log WHERE user_id = ? AND domain = 'figma.com' ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER) as any
  assert.equal(figmaLog?.domain_category, 'design', `Expected design, got ${figmaLog?.domain_category}`)
})

await runAsync('desktop scan: stored correctly in snapshot', async () => {
  const fakeScan = {
    desktop_file_types: { '.pdf': 3, '.xlsx': 5 },
    desktop_file_count: 8,
    desktop_folder_count: 12,
    home_top_folders: ['Documents', 'Desktop', 'Projects'],
    active_app_categories: ['browser', 'dev'],
    scanned_at: new Date().toISOString(),
  }

  await extractChannelCSignals({
    userId: TEST_USER,
    sessionId: TEST_SESSION + '-t5',
    taskType: 'browser',
    domainsVisited: ['notion.so'],
    fileExtensions: [],
    folderNames: [],
    desktopScan: fakeScan,
  })

  const row = db.prepare(
    "SELECT * FROM channel_c_task_snapshots WHERE user_id = ? AND session_id = ?"
  ).get(TEST_USER, TEST_SESSION + '-t5') as any

  assert.equal(row.desktop_scanned, 1)
  assert.equal(row.desktop_folder_count, 12)

  const fileTypes = JSON.parse(row.desktop_file_types)
  assert.equal(fileTypes['.pdf'], 3)
  assert.equal(fileTypes['.xlsx'], 5)

  const homefolders = JSON.parse(row.home_top_folders)
  assert.ok(homefolders.includes('Projects'), `Expected Projects in home folders, got: ${JSON.stringify(homefolders)}`)
})

console.log('\nIntegration Tests — Accumulator')

await runAsync('accumulator: addDomain deduplicates and extracts domain', async () => {
  const acc = new ChannelCAccumulator()
  acc.addDomain('https://notion.so/workspace/abc')
  acc.addDomain('https://notion.so/another-page')  // same domain — should dedupe
  acc.addDomain('https://github.com/user/repo')

  assert.equal(acc.hasData(), true)
  assert.equal(acc.deriveTaskType(), 'browser')

  // Flush and verify snapshot created
  const ACC_USER = 'test-cc-accumulator-user'
  db.prepare("DELETE FROM channel_c_task_snapshots WHERE user_id = ?").run(ACC_USER)

  acc.flush(ACC_USER, 'acc-session-1', acc.deriveTaskType())
  // flush is async (fire-and-forget) — wait briefly for it to complete
  await new Promise(r => setTimeout(r, 100))

  const row = db.prepare(
    "SELECT domain_count, primary_domain FROM channel_c_task_snapshots WHERE user_id = ? LIMIT 1"
  ).get(ACC_USER) as any

  assert.ok(row, 'Accumulator flush should create a snapshot row')
  assert.equal(row.domain_count, 2, `Expected 2 unique domains, got ${row.domain_count}`)
  assert.equal(row.primary_domain, 'notion.so')

  db.prepare("DELETE FROM channel_c_task_snapshots WHERE user_id = ?").run(ACC_USER)
  db.prepare("DELETE FROM channel_c_domain_log WHERE user_id = ?").run(ACC_USER)
})

await runAsync('accumulator: addFileAccess extracts extension and folder name', async () => {
  const acc = new ChannelCAccumulator()
  acc.addFileAccess('C:\\Users\\manol\\Documents\\Projects\\report.xlsx')
  acc.addFileAccess('/home/user/code/src/index.ts')

  assert.equal(acc.deriveTaskType(), 'local')
  assert.equal(acc.hasData(), true)
})

await runAsync('accumulator: deriveTaskType = hybrid when both domains and files present', async () => {
  const acc = new ChannelCAccumulator()
  acc.addDomain('https://notion.so')
  acc.addFileAccess('/home/user/docs/notes.md')
  assert.equal(acc.deriveTaskType(), 'hybrid')
})

await runAsync('accumulator: hasData = false when nothing added', async () => {
  const acc = new ChannelCAccumulator()
  assert.equal(acc.hasData(), false)
})

// ── PROFILE BUILDER (Part 4) ──────────────────────────────────────────────────
import { getChannelCProfile, updateChannelCProfile } from '../lib/channel-c/profile-builder.js'

const PROFILE_USER = 'test-cc-profile-user'
db.prepare("DELETE FROM channel_c_task_snapshots WHERE user_id = ?").run(PROFILE_USER)
db.prepare("DELETE FROM channel_c_domain_log WHERE user_id = ?").run(PROFILE_USER)
db.prepare("DELETE FROM channel_c_profiles WHERE user_id = ?").run(PROFILE_USER)

console.log('\nProfile Builder — updateChannelCProfile + getChannelCProfile')

await runAsync('profile: null for unknown user', async () => {
  const profile = getChannelCProfile('nonexistent-user-xyz-abc')
  assert.equal(profile, null)
})

await runAsync('profile: created after first signal', async () => {
  // Insert a domain log row first (updateChannelCProfile queries domain log)
  db.prepare(
    "INSERT INTO channel_c_domain_log (id, user_id, created_at, domain, domain_category, is_research_artifact, task_count) VALUES (?, ?, datetime('now'), 'notion.so', 'productivity', 0, 1)"
  ).run(randomUUID(), PROFILE_USER)

  updateChannelCProfile(PROFILE_USER, {
    taskType: 'browser',
    taskHour: 10,
    taskDayOfWeek: 1, // Monday
    domainCategories: ['productivity'],
    isResearchTask: false,
    fileExtensions: [],
    desktopScan: null,
  })

  const profile = getChannelCProfile(PROFILE_USER)
  assert.ok(profile, 'Profile should exist after first update')
  assert.equal(profile!.total_tasks_observed, 1)
})

await runAsync('profile: work_time_profile accumulates hour distribution', async () => {
  // Add 4 more tasks at hour 10 to build up signal
  for (let i = 0; i < 4; i++) {
    updateChannelCProfile(PROFILE_USER, {
      taskType: 'browser',
      taskHour: 10,
      taskDayOfWeek: 1,
      domainCategories: ['productivity'],
      isResearchTask: false,
      fileExtensions: [],
      desktopScan: null,
    })
  }

  const profile = getChannelCProfile(PROFILE_USER)
  assert.ok(profile?.work_time_profile, 'work_time_profile should exist')
  assert.equal(profile!.work_time_profile!.hour_distribution[10], 5, `Expected 5 at hour 10, got ${profile!.work_time_profile!.hour_distribution[10]}`)
  assert.equal(profile!.work_time_profile!.total_task_count, 5)
  assert.equal(profile!.work_time_profile!.peak_hour, 10, 'Peak hour should be 10 after 5 tasks')
  assert.equal(profile!.work_time_profile!.schedule_type, 'standard', `Expected standard schedule, got ${profile!.work_time_profile!.schedule_type}`)
  assert.equal(profile!.work_time_profile!.works_weekends, false, 'Should not mark as weekend worker for Monday tasks')
})

await runAsync('profile: works_weekends = true when weekend task observed', async () => {
  updateChannelCProfile(PROFILE_USER, {
    taskType: 'browser',
    taskHour: 10,
    taskDayOfWeek: 6, // Saturday
    domainCategories: ['productivity'],
    isResearchTask: false,
    fileExtensions: [],
    desktopScan: null,
  })

  const profile = getChannelCProfile(PROFILE_USER)
  assert.equal(profile!.work_time_profile!.works_weekends, true)
})

await runAsync('profile: file_type_profile accumulates from file extensions', async () => {
  updateChannelCProfile(PROFILE_USER, {
    taskType: 'local',
    taskHour: 14,
    taskDayOfWeek: 2,
    domainCategories: [],
    isResearchTask: false,
    fileExtensions: ['.ts', '.tsx', '.ts'], // dupes don't matter here
    desktopScan: null,
  })

  const profile = getChannelCProfile(PROFILE_USER)
  const ftp = profile?.file_type_profile
  assert.ok(ftp, 'file_type_profile should exist')
  assert.ok(ftp!.by_category['code'] >= 2, `Expected code ≥ 2, got ${ftp!.by_category['code']}`)
  assert.equal(ftp!.dominant_file_type, 'code', `Expected dominant = code, got ${ftp!.dominant_file_type}`)
  assert.equal(ftp!.work_type_inference, 'developer', `Expected developer, got ${ftp!.work_type_inference}`)
})

await runAsync('profile: tool_stack_profile computed from domain log', async () => {
  // Insert enough domain log entries for notion.so to appear as top tool (need 3+)
  for (let i = 0; i < 3; i++) {
    db.prepare(
      "INSERT INTO channel_c_domain_log (id, user_id, created_at, domain, domain_category, is_research_artifact, task_count) VALUES (?, ?, datetime('now'), 'notion.so', 'productivity', 0, 1)"
    ).run(randomUUID(), PROFILE_USER)
  }

  updateChannelCProfile(PROFILE_USER, {
    taskType: 'browser',
    taskHour: 9,
    taskDayOfWeek: 1,
    domainCategories: ['productivity'],
    isResearchTask: false,
    fileExtensions: [],
    desktopScan: null,
  })

  const profile = getChannelCProfile(PROFILE_USER)
  const ts = profile?.tool_stack_profile
  assert.ok(ts, 'tool_stack_profile should exist')
  assert.ok(ts!.top_tools.includes('notion.so'), `Expected notion.so in top_tools, got: ${JSON.stringify(ts!.top_tools)}`)
  assert.equal(ts!.uses_notion, true)
})

await runAsync('profile: desktop_profile set when scan provided', async () => {
  const fakeScan = {
    desktop_file_types: { '.pdf': 5, '.docx': 8, '.xlsx': 3 },
    desktop_file_count: 16,
    desktop_folder_count: 4,
    home_top_folders: ['Documents', 'Projects', 'Downloads'],
    active_app_categories: ['dev', 'browser'],
    scanned_at: new Date().toISOString(),
  }

  updateChannelCProfile(PROFILE_USER, {
    taskType: 'browser',
    taskHour: 11,
    taskDayOfWeek: 3,
    domainCategories: ['productivity'],
    isResearchTask: false,
    fileExtensions: [],
    desktopScan: fakeScan,
  })

  const profile = getChannelCProfile(PROFILE_USER)
  const dsk = profile?.desktop_profile
  assert.ok(dsk, 'desktop_profile should exist after scan')
  assert.equal(dsk!.desktop_file_count, 16)
  assert.equal(dsk!.organization_style, 'moderate', `Expected moderate (16 files), got ${dsk!.organization_style}`)
  assert.equal(dsk!.desktop_dominant_type, '.docx', `Expected .docx dominant, got ${dsk!.desktop_dominant_type}`)
  assert.ok(dsk!.home_folder_names.includes('Projects'))
  assert.ok(dsk!.active_app_categories.includes('dev'))
})

await runAsync('profile: desktop_profile stays when next update has no scan', async () => {
  updateChannelCProfile(PROFILE_USER, {
    taskType: 'browser',
    taskHour: 11,
    taskDayOfWeek: 3,
    domainCategories: ['productivity'],
    isResearchTask: false,
    fileExtensions: [],
    desktopScan: null, // no scan this time
  })

  const profile = getChannelCProfile(PROFILE_USER)
  assert.ok(profile?.desktop_profile, 'desktop_profile should persist when scan=null')
  assert.equal(profile!.desktop_profile!.desktop_file_count, 16, 'Previous scan data should remain')
})

// ── CONTEXT BUILDER (Part 5) ──────────────────────────────────────────────────
import { buildChannelCContextBlock, buildDebugReport as buildCCDebugReport } from '../lib/channel-c/context-builder.js'
import { randomUUID } from 'crypto'

const CONTEXT_USER = 'test-cc-context-user'
db.prepare("DELETE FROM channel_c_task_snapshots WHERE user_id = ?").run(CONTEXT_USER)
db.prepare("DELETE FROM channel_c_domain_log WHERE user_id = ?").run(CONTEXT_USER)
db.prepare("DELETE FROM channel_c_profiles WHERE user_id = ?").run(CONTEXT_USER)

console.log('\nContext Builder — buildChannelCContextBlock')

await runAsync('context: empty string for unknown user (cold start)', async () => {
  assert.equal(buildChannelCContextBlock('completely-unknown-user-xyz'), '')
})

await runAsync('context: empty string below cold-start gate (< 5 tasks)', async () => {
  // Insert 4 tasks — just below the gate
  for (let i = 0; i < 4; i++) {
    updateChannelCProfile(CONTEXT_USER, {
      taskType: 'browser',
      taskHour: 10,
      taskDayOfWeek: 1,
      domainCategories: ['productivity'],
      isResearchTask: false,
      fileExtensions: [],
      desktopScan: null,
    })
  }
  assert.equal(buildChannelCContextBlock(CONTEXT_USER), '', 'Should be empty below gate')
})

await runAsync('context: non-empty after 5th task (cold-start passed)', async () => {
  // Add domain log entries so tool stack has data
  for (let i = 0; i < 4; i++) {
    db.prepare(
      "INSERT INTO channel_c_domain_log (id, user_id, created_at, domain, domain_category, is_research_artifact, task_count) VALUES (?, ?, datetime('now'), 'github.com', 'dev', 0, 1)"
    ).run(randomUUID(), CONTEXT_USER)
  }

  // 5th task — passes the gate
  updateChannelCProfile(CONTEXT_USER, {
    taskType: 'local',
    taskHour: 10,
    taskDayOfWeek: 1,
    domainCategories: ['dev'],
    isResearchTask: false,
    fileExtensions: ['.ts', '.js', '.ts'],
    desktopScan: null,
  })

  const block = buildChannelCContextBlock(CONTEXT_USER)
  assert.ok(block.length > 0, 'Context block should be non-empty after 5 tasks')
  assert.ok(block.startsWith('## Environment Intelligence'), `Expected header, got: ${block.substring(0, 50)}`)
})

await runAsync('context: work type line included when developer inferred', async () => {
  const block = buildChannelCContextBlock(CONTEXT_USER)
  assert.ok(
    block.includes('developer') || block.includes('technical'),
    `Expected developer-oriented line in: ${block}`
  )
})

await runAsync('debug report: returns string with section headers', async () => {
  const report = buildCCDebugReport(CONTEXT_USER)
  assert.ok(report.includes('CHANNEL C DEBUG REPORT'), 'Should have title')
  assert.ok(report.includes('C.1 — TOOL STACK'), 'Should have tool stack section')
  assert.ok(report.includes('C.2 — WORK TYPE'), 'Should have work type section')
  assert.ok(report.includes('C.3 — WORK SCHEDULE'), 'Should have schedule section')
  assert.ok(report.includes('C.4 — DOMAIN PROFILE'), 'Should have domain section')
  assert.ok(report.includes('CONTEXT BLOCK'), 'Should have context block preview')
})

await runAsync('debug report: cold start gate shown correctly', async () => {
  const report = buildCCDebugReport(CONTEXT_USER)
  assert.ok(report.includes('PASSED'), 'Should show gate as PASSED for this user')
})

// ── SUMMARY ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Channel C — Results: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('SOME TESTS FAILED')
  process.exit(1)
} else {
  console.log('ALL TESTS PASSED')
}
