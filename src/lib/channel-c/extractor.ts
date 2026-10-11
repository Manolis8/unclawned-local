import { classifyDomain } from './domain-classifier.js'
import { classifyFileType } from './file-classifier.js'
import { insertTaskSnapshot, upsertDomainLog } from './signal-inserter.js'
import type { DesktopScanResult } from './env-scanner.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChannelCInput {
  userId: string
  sessionId: string | null
  taskType: string
  domainsVisited: string[]
  fileExtensions: string[]
  folderNames: string[]
  desktopScan?: DesktopScanResult | null
}

// ─── Research task detection ──────────────────────────────────────────────────
//
// Research tasks visit domains to READ (information gathering) not ACT.
// Their domains are logged but do NOT count toward tool_stack_profile.
// See PROBLEM 1 in the plan.

const RESEARCH_TASK_TYPES = new Set(['research', 'analyze'])

function isResearchTask(taskType: string): boolean {
  return RESEARCH_TASK_TYPES.has(taskType.toLowerCase())
}

// ─── Primary domain ───────────────────────────────────────────────────────────
//
// In a task with multiple domains, the primary domain is the first non-research
// domain visited (the likely destination). For pure-research tasks it's the first.

function pickPrimaryDomain(domains: string[]): string | null {
  return domains[0] ?? null
}

// ─── extractChannelCSignals ───────────────────────────────────────────────────
//
// Main entry point. Called by ChannelCAccumulator.flush() — fire-and-forget.
// Runs the full pipeline: classify → insert snapshot → log domains → update profile.

export async function extractChannelCSignals(input: ChannelCInput): Promise<void> {
  const now = new Date()
  const taskHour = now.getHours()
  const taskDayOfWeek = now.getDay()   // 0=Sunday

  const researchTask = isResearchTask(input.taskType)

  // ── 1. Classify domains ────────────────────────────────────────────────────
  const domainCategories: string[] = []
  const categorySet = new Set<string>()

  for (const domain of input.domainsVisited) {
    const cat = classifyDomain(domain)
    if (!categorySet.has(cat)) {
      categorySet.add(cat)
      domainCategories.push(cat)
    }
  }

  const primaryDomain = pickPrimaryDomain(input.domainsVisited)

  // ── 2. Classify file types (for validation — already extracted in accumulator) ─
  // File extensions are passed in pre-extracted; we validate they look like extensions
  const validExtensions = input.fileExtensions.filter(e => e.startsWith('.'))

  // ── 3. Insert task snapshot ────────────────────────────────────────────────
  const desktopScanned = !!input.desktopScan
  insertTaskSnapshot({
    userId: input.userId,
    sessionId: input.sessionId,
    taskType: input.taskType,
    taskHour,
    taskDayOfWeek,
    domainsVisited: input.domainsVisited,
    domainCategories,
    primaryDomain,
    isResearchTask: researchTask,
    fileExtensions: validExtensions,
    folderNames: input.folderNames,
    desktopScan: input.desktopScan ?? null,
    desktopScanned,
  })

  // ── 4. Log each domain ────────────────────────────────────────────────────
  for (const domain of input.domainsVisited) {
    const category = classifyDomain(domain)
    upsertDomainLog(input.userId, domain, category, researchTask)
  }

  // ── 5. Update profile (imported lazily to avoid circular dep at startup) ──
  try {
    const { updateChannelCProfile } = await import('./profile-builder.js')
    updateChannelCProfile(input.userId, {
      taskType: input.taskType,
      taskHour,
      taskDayOfWeek,
      domainCategories,
      isResearchTask: researchTask,
      fileExtensions: validExtensions,
      desktopScan: input.desktopScan ?? null,
    })
  } catch (err) {
    console.error('[channel-c] profile update error:', err)
  }
}
