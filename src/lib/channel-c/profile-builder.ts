import { db, j, p } from '../db.js'
import { classifyFileType, inferWorkType } from './file-classifier.js'
import { classifySchedule } from './env-scanner.js'
import type { DesktopScanResult, ScheduleType } from './env-scanner.js'

// ─── Profile types ─────────────────────────────────────────────────────────────

export interface ToolStackProfile {
  dominant_categories: string[]
  top_tools: string[]
  tool_stack_type: 'dev' | 'operator' | 'designer' | 'analyst' | 'writer' | 'mixed'
  uses_notion: boolean
  uses_github: boolean
  uses_figma: boolean
  uses_linear: boolean
  uses_slack: boolean
  uses_gmail: boolean
}

export interface DomainProfile {
  top_domains: { domain: string; count: number; category: string }[]
  category_distribution: Record<string, number>
  primary_category: string | null
  research_heavy: boolean
  ai_tools_heavy: boolean
}

export interface FileTypeProfile {
  by_category: Record<string, number>
  dominant_file_type: string
  work_type_inference: string
  total_file_accesses: number
}

export interface WorkTimeProfile {
  hour_distribution: number[]
  peak_hour: number | null
  schedule_type: ScheduleType
  works_weekends: boolean
  total_task_count: number
}

export interface DesktopProfile {
  desktop_file_count: number
  desktop_dominant_type: string | null
  home_folder_count: number
  home_folder_names: string[]
  organization_style: 'clean' | 'moderate' | 'cluttered'
  active_app_categories: string[]
  last_scan_at: string
}

export interface ChannelCProfile {
  total_tasks_observed: number
  profile_version: number
  last_updated: string
  tool_stack_profile: ToolStackProfile | null
  domain_profile: DomainProfile | null
  file_type_profile: FileTypeProfile | null
  work_time_profile: WorkTimeProfile | null
  desktop_profile: DesktopProfile | null
}

export interface ChannelCProfileUpdate {
  taskType: string
  taskHour: number
  taskDayOfWeek: number
  domainCategories: string[]
  isResearchTask: boolean
  fileExtensions: string[]
  desktopScan: DesktopScanResult | null
}

// ─── getChannelCProfile ────────────────────────────────────────────────────────

export function getChannelCProfile(userId: string): ChannelCProfile | null {
  const row = db.prepare(
    'SELECT * FROM channel_c_profiles WHERE user_id = ?'
  ).get(userId) as any
  if (!row) return null

  return {
    total_tasks_observed: row.total_tasks_observed ?? 0,
    profile_version: row.profile_version ?? 1,
    last_updated: row.last_updated ?? '',
    tool_stack_profile: p(row.tool_stack_profile),
    domain_profile: p(row.domain_profile),
    file_type_profile: p(row.file_type_profile),
    work_time_profile: p(row.work_time_profile),
    desktop_profile: p(row.desktop_profile),
  }
}

// ─── computeToolStackProfile ─────────────────────────────────────────────────
//
// Queries non-research domain visits in last 30 days.
// Only domains with is_research_artifact = 0 count toward tool stack.
// (See Problem 1 in the plan — research task domains contaminate tool stack)

function computeToolStackProfile(userId: string): ToolStackProfile {
  const rows = db.prepare(`
    SELECT domain, domain_category, COUNT(*) AS cnt
    FROM channel_c_domain_log
    WHERE user_id = ? AND is_research_artifact = 0
      AND created_at >= datetime('now', '-30 days')
    GROUP BY domain
    ORDER BY cnt DESC
    LIMIT 50
  `).all(userId) as Array<{ domain: string; domain_category: string; cnt: number }>

  const totalVisits = rows.reduce((s, r) => s + r.cnt, 0)
  const categoryCounts: Record<string, number> = {}
  const topTools: string[] = []
  const domainSet = new Set<string>()

  for (const row of rows) {
    categoryCounts[row.domain_category] = (categoryCounts[row.domain_category] ?? 0) + row.cnt
    if (row.cnt >= 3) topTools.push(row.domain)
    domainSet.add(row.domain)
  }

  // Dominant categories: > 15% of total non-research domain visits
  const dominantCategories: string[] = []
  if (totalVisits > 0) {
    for (const [cat, count] of Object.entries(categoryCounts)) {
      if (count / totalVisits > 0.15) dominantCategories.push(cat)
    }
  }

  return {
    dominant_categories: dominantCategories,
    top_tools: topTools,
    tool_stack_type: inferToolStackType(dominantCategories),
    uses_notion: domainSet.has('notion.so'),
    uses_github: domainSet.has('github.com'),
    uses_figma: domainSet.has('figma.com'),
    uses_linear: domainSet.has('linear.app'),
    uses_slack: domainSet.has('slack.com'),
    uses_gmail: domainSet.has('gmail.com') || domainSet.has('mail.google.com'),
  }
}

function inferToolStackType(
  dominantCategories: string[]
): 'dev' | 'operator' | 'designer' | 'analyst' | 'writer' | 'mixed' {
  const cats = new Set(dominantCategories)
  if (cats.has('dev')) return 'dev'
  if (cats.has('design')) return 'designer'
  if (cats.has('data')) return 'analyst'
  if (cats.has('content')) return 'writer'
  if (cats.has('productivity') || cats.has('communication')) return 'operator'
  return 'mixed'
}

// ─── computeDomainProfile ─────────────────────────────────────────────────────
//
// All domain visits in last 30 days (research + non-research).
// Builds the domain frequency picture for context injection.

function computeDomainProfile(userId: string): DomainProfile {
  const rows = db.prepare(`
    SELECT domain, domain_category, COUNT(*) AS cnt
    FROM channel_c_domain_log
    WHERE user_id = ?
      AND created_at >= datetime('now', '-30 days')
    GROUP BY domain
    ORDER BY cnt DESC
    LIMIT 20
  `).all(userId) as Array<{ domain: string; domain_category: string; cnt: number }>

  const totalVisits = rows.reduce((s, r) => s + r.cnt, 0)
  const categoryRaw: Record<string, number> = {}

  for (const row of rows) {
    categoryRaw[row.domain_category] = (categoryRaw[row.domain_category] ?? 0) + row.cnt
  }

  // Normalize to fractions
  const categoryDistribution: Record<string, number> = {}
  if (totalVisits > 0) {
    for (const [cat, count] of Object.entries(categoryRaw)) {
      categoryDistribution[cat] = Math.round((count / totalVisits) * 100) / 100
    }
  }

  const primaryCategory = rows.length > 0 ? rows[0].domain_category : null

  return {
    top_domains: rows.slice(0, 10).map(r => ({
      domain: r.domain,
      count: r.cnt,
      category: r.domain_category,
    })),
    category_distribution: categoryDistribution,
    primary_category: primaryCategory,
    research_heavy: (categoryDistribution['research'] ?? 0) > 0.30,
    ai_tools_heavy: (categoryDistribution['ai_tools'] ?? 0) > 0.20,
  }
}

// ─── updateChannelCProfile ─────────────────────────────────────────────────────
//
// Called after every task snapshot is inserted.
// Updates running accumulators (work time, file types) and recomputes
// SQL-backed profiles (tool stack, domain profile) from the domain log.

export function updateChannelCProfile(userId: string, update: ChannelCProfileUpdate): void {
  const existing = getChannelCProfile(userId)

  // ── Work time profile — running accumulator ──────────────────────────────────
  const wtp: WorkTimeProfile = existing?.work_time_profile ?? {
    hour_distribution: new Array(24).fill(0),
    peak_hour: null,
    schedule_type: 'irregular',
    works_weekends: false,
    total_task_count: 0,
  }

  wtp.hour_distribution[update.taskHour] = (wtp.hour_distribution[update.taskHour] ?? 0) + 1
  wtp.total_task_count += 1
  if (update.taskDayOfWeek === 0 || update.taskDayOfWeek === 6) {
    wtp.works_weekends = true
  }

  wtp.schedule_type = classifySchedule(wtp.hour_distribution)

  // Recompute peak hour
  let peakHour = 0
  let peakCount = 0
  for (let h = 0; h < 24; h++) {
    if (wtp.hour_distribution[h] > peakCount) {
      peakCount = wtp.hour_distribution[h]
      peakHour = h
    }
  }
  wtp.peak_hour = wtp.total_task_count >= 5 ? peakHour : null

  // ── File type profile — running accumulator ──────────────────────────────────
  const ftp: FileTypeProfile = existing?.file_type_profile ?? {
    by_category: {},
    dominant_file_type: 'mixed',
    work_type_inference: 'mixed',
    total_file_accesses: 0,
  }

  for (const ext of update.fileExtensions) {
    const cat = classifyFileType(ext)
    if (cat !== 'other') {
      ftp.by_category[cat] = (ftp.by_category[cat] ?? 0) + 1
      ftp.total_file_accesses += 1
    }
  }

  if (ftp.total_file_accesses > 0) {
    ftp.work_type_inference = inferWorkType(ftp.by_category)
    // Pick dominant file category
    let maxCat = 'mixed'
    let maxCount = 0
    for (const [cat, count] of Object.entries(ftp.by_category)) {
      if (count > maxCount) { maxCount = count; maxCat = cat }
    }
    ftp.dominant_file_type = maxCat
  }

  // ── Desktop profile — update only when a scan is present ────────────────────
  let dtp: DesktopProfile | null = existing?.desktop_profile ?? null
  if (update.desktopScan) {
    const scan = update.desktopScan
    const fileCount = scan.desktop_file_count
    const orgStyle: 'clean' | 'moderate' | 'cluttered' =
      fileCount < 10 ? 'clean' : fileCount <= 30 ? 'moderate' : 'cluttered'

    let dominantType: string | null = null
    let maxFileCount = 0
    for (const [ext, count] of Object.entries(scan.desktop_file_types)) {
      if (count > maxFileCount) { maxFileCount = count; dominantType = ext }
    }

    dtp = {
      desktop_file_count: fileCount,
      desktop_dominant_type: dominantType,
      home_folder_count: scan.home_top_folders.length,
      home_folder_names: scan.home_top_folders,
      organization_style: orgStyle,
      active_app_categories: scan.active_app_categories,
      last_scan_at: scan.scanned_at,
    }
  }

  // ── Tool stack + domain profiles — recomputed from domain log SQL ────────────
  // These need rolling 30-day windows so they're computed fresh each update.
  const toolStackProfile = computeToolStackProfile(userId)
  const domainProfile = computeDomainProfile(userId)

  const totalTasks = (existing?.total_tasks_observed ?? 0) + 1

  db.prepare(`
    INSERT INTO channel_c_profiles
      (user_id, last_updated, profile_version, total_tasks_observed,
       tool_stack_profile, domain_profile, file_type_profile, work_time_profile, desktop_profile)
    VALUES (?, datetime('now'), 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_updated = datetime('now'),
      total_tasks_observed = excluded.total_tasks_observed,
      tool_stack_profile = excluded.tool_stack_profile,
      domain_profile = excluded.domain_profile,
      file_type_profile = excluded.file_type_profile,
      work_time_profile = excluded.work_time_profile,
      desktop_profile = CASE
        WHEN excluded.desktop_profile IS NOT NULL THEN excluded.desktop_profile
        ELSE desktop_profile
      END
  `).run(
    userId,
    totalTasks,
    j(toolStackProfile),
    j(domainProfile),
    j(ftp),
    j(wtp),
    j(dtp),
  )
}
