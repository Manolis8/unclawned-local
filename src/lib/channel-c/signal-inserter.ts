import { db, j } from '../db.js'
import { randomUUID } from 'crypto'
import type { DesktopScanResult } from './env-scanner.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskSnapshotInput {
  userId: string
  sessionId: string | null
  taskType: string
  taskHour: number
  taskDayOfWeek: number
  domainsVisited: string[]
  domainCategories: string[]
  primaryDomain: string | null
  isResearchTask: boolean
  fileExtensions: string[]
  folderNames: string[]
  desktopScan: DesktopScanResult | null
  desktopScanned: boolean
}

// ─── insertTaskSnapshot ───────────────────────────────────────────────────────

export function insertTaskSnapshot(input: TaskSnapshotInput): string {
  const id = randomUUID()

  db.prepare(`
    INSERT INTO channel_c_task_snapshots (
      id, user_id, session_id, created_at,
      task_type, task_hour, task_day_of_week,
      domains_visited, domain_categories, primary_domain, domain_count, is_research_task,
      file_extensions, folder_names, file_count,
      desktop_scanned, desktop_file_types, desktop_folder_count, home_top_folders, active_app_categories
    ) VALUES (
      ?, ?, ?, datetime('now'),
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `).run(
    id,
    input.userId,
    input.sessionId,
    input.taskType,
    input.taskHour,
    input.taskDayOfWeek,
    j(input.domainsVisited),
    j(input.domainCategories),
    input.primaryDomain,
    input.domainsVisited.length,
    input.isResearchTask ? 1 : 0,
    j(input.fileExtensions),
    j(input.folderNames),
    input.fileExtensions.length,
    input.desktopScanned ? 1 : 0,
    input.desktopScan ? j(input.desktopScan.desktop_file_types) : null,
    input.desktopScan?.desktop_folder_count ?? null,
    input.desktopScan ? j(input.desktopScan.home_top_folders) : null,
    input.desktopScan ? j(input.desktopScan.active_app_categories) : null,
  )

  return id
}

// ─── upsertDomainLog ──────────────────────────────────────────────────────────
//
// Inserts a new row for each (user, domain) pair per task.
// The domain log is append-only — one row per task visit.
// Profile builder aggregates it with GROUP BY / rolling windows.

export function upsertDomainLog(
  userId: string,
  domain: string,
  category: string,
  isResearchArtifact: boolean
): void {
  db.prepare(`
    INSERT INTO channel_c_domain_log (id, user_id, created_at, domain, domain_category, is_research_artifact, task_count)
    VALUES (?, ?, datetime('now'), ?, ?, ?, 1)
  `).run(
    randomUUID(),
    userId,
    domain,
    category,
    isResearchArtifact ? 1 : 0
  )
}
