import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type AppCategory =
  | 'productivity'
  | 'dev'
  | 'design'
  | 'communication'
  | 'browser'
  | 'office'
  | 'finance'
  | 'media'

export interface DesktopScanResult {
  desktop_file_types: Record<string, number>    // { ".pdf": 3, ".xlsx": 5 }
  desktop_file_count: number
  desktop_folder_count: number
  home_top_folders: string[]                    // names only, no full paths
  active_app_categories: string[]               // categories seen in running processes
  scanned_at: string
}

export interface AppCategoryCount {
  [category: string]: number
}

// ─── Load app-categories dictionary ──────────────────────────────────────────

let _appMap: Map<string, AppCategory> | null = null

function getAppMap(): Map<string, AppCategory> {
  if (_appMap) return _appMap

  const raw = readFileSync(join(__dirname, '../../data/app-categories.json'), 'utf8')
  const data: Record<string, string[]> = JSON.parse(raw)

  _appMap = new Map()
  for (const [category, appNames] of Object.entries(data)) {
    for (const name of appNames) {
      _appMap.set(name.toLowerCase(), category as AppCategory)
    }
  }
  return _appMap
}

// ─── classifyProcesses ────────────────────────────────────────────────────────
//
// Allowlist-only: only processes that appear in app-categories.json are counted.
// Everything else is discarded (svchost, RuntimeBroker, antivirus, etc.).

export function classifyProcesses(processList: string[]): AppCategoryCount {
  const map = getAppMap()
  const counts: AppCategoryCount = {}

  for (const proc of processList) {
    const lower = proc.toLowerCase()
      .replace(/\.exe$/i, '')   // strip .exe suffix
      .trim()

    const category = map.get(lower)
    if (category) {
      counts[category] = (counts[category] ?? 0) + 1
    }
  }
  return counts
}

// ─── scanDesktop ──────────────────────────────────────────────────────────────
//
// Runs a shallow desktop + home directory scan via PowerShell (Windows).
// Privacy design: counts and names only — no full paths, no filenames.
//
// Returns null if the scan fails (e.g. no shell access, permissions error).

export function scanDesktop(homeDir: string, desktopDir: string): DesktopScanResult | null {
  try {
    const result = runDesktopScan(homeDir, desktopDir)
    return result
  } catch {
    return null
  }
}

function runDesktopScan(homeDir: string, desktopDir: string): DesktopScanResult {
  const desktopFileTypes: Record<string, number> = {}
  let desktopFileCount = 0
  let desktopFolderCount = 0

  // ── Desktop file types ────────────────────────────────────────────────────
  try {
    const cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${desktopDir}' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Extension.ToLower() } | Group-Object | Select-Object Name,Count | ConvertTo-Json -Compress"`
    const raw = execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim()

    if (raw && raw !== 'null') {
      const parsed = JSON.parse(raw)
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        const ext = item.Name || ''
        const count = item.Count ?? 1
        if (ext) desktopFileTypes[ext] = count
        desktopFileCount += count
      }
    }
  } catch { /* non-fatal */ }

  // ── Desktop folder count ─────────────────────────────────────────────────
  try {
    const cmd = `powershell -NoProfile -Command "(Get-ChildItem -Path '${desktopDir}' -Directory -ErrorAction SilentlyContinue).Count"`
    const raw = execSync(cmd, { timeout: 3000, encoding: 'utf8' }).trim()
    desktopFolderCount = parseInt(raw, 10) || 0
  } catch { /* non-fatal */ }

  // ── Home top-level folder names ──────────────────────────────────────────
  const homeTopFolders: string[] = []
  try {
    const cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${homeDir}' -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress"`
    const raw = execSync(cmd, { timeout: 3000, encoding: 'utf8' }).trim()
    if (raw && raw !== 'null') {
      const parsed = JSON.parse(raw)
      const folders = Array.isArray(parsed) ? parsed : [parsed]
      homeTopFolders.push(...folders.filter((f: unknown) => typeof f === 'string').slice(0, 20))
    }
  } catch { /* non-fatal */ }

  // ── Running processes → app categories (allowlist-only) ──────────────────
  const activeAppCategories: string[] = []
  try {
    const cmd = `powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Sort-Object CPU -Desc | Select-Object -First 30 -ExpandProperty ProcessName | ConvertTo-Json -Compress"`
    const raw = execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim()
    if (raw && raw !== 'null') {
      const parsed = JSON.parse(raw)
      const processList = Array.isArray(parsed) ? parsed : [parsed]
      const categoryCounts = classifyProcesses(processList)
      activeAppCategories.push(...Object.keys(categoryCounts))
    }
  } catch { /* non-fatal */ }

  return {
    desktop_file_types: desktopFileTypes,
    desktop_file_count: desktopFileCount,
    desktop_folder_count: desktopFolderCount,
    home_top_folders: homeTopFolders,
    active_app_categories: activeAppCategories,
    scanned_at: new Date().toISOString(),
  }
}

// ─── Schedule type classifier ─────────────────────────────────────────────────

export type ScheduleType = 'early_bird' | 'standard' | 'night_owl' | 'irregular'

export function classifySchedule(hourDistribution: number[]): ScheduleType {
  if (hourDistribution.length !== 24) return 'irregular'

  const total = hourDistribution.reduce((s, n) => s + n, 0)
  if (total === 0) return 'irregular'

  // Find peak hour
  let peakHour = 0
  let peakCount = 0
  for (let h = 0; h < 24; h++) {
    if (hourDistribution[h] > peakCount) {
      peakCount = hourDistribution[h]
      peakHour = h
    }
  }

  // Irregular if peak hour has < 2.5x the hourly average — no clear dominant time
  const mean = total / 24
  if (peakCount / mean < 2.5) return 'irregular'

  if (peakHour >= 5 && peakHour <= 8)   return 'early_bird'
  if (peakHour >= 20 || peakHour <= 2)  return 'night_owl'
  return 'standard'
}
