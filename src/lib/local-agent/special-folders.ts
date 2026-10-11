import { execFileSync } from 'child_process'
import { homedir } from 'os'
import path from 'path'
import fs from 'fs'

// ─── Windows Shell folder resolution ─────────────────────────────────────────
// On Windows, special folders like Desktop can be redirected to a different
// physical path (e.g. OneDrive\Desktop). The only reliable way to get the real
// path is through the Windows Shell API — the same source Windows Explorer uses.
// We query it once at startup via PowerShell and cache the results.
//
// On macOS/Linux, ~/Desktop is always the right path — no redirection occurs.

export interface SpecialFolders {
  Desktop: string
  Documents: string
  Downloads: string
  Pictures: string
  Music: string
  Videos: string
}

let _folders: SpecialFolders | null = null

function buildFolders(): SpecialFolders {
  const home = homedir()
  const naive = (name: string) => path.join(home, name)

  if (process.platform !== 'win32') {
    return {
      Desktop:   naive('Desktop'),
      Documents: naive('Documents'),
      Downloads: naive('Downloads'),
      Pictures:  naive('Pictures'),
      Music:     naive('Music'),
      Videos:    naive('Videos'),
    }
  }

  // PowerShell script that returns all folders as JSON in one call
  const script = [
    '$d = @{',
    "  Desktop   = [Environment]::GetFolderPath('Desktop')",
    "  Documents = [Environment]::GetFolderPath('MyDocuments')",
    "  Pictures  = [Environment]::GetFolderPath('MyPictures')",
    "  Music     = [Environment]::GetFolderPath('MyMusic')",
    "  Videos    = [Environment]::GetFolderPath('MyVideos')",
    // Downloads isn't in .NET's Environment.SpecialFolder — use the registry key
    "  Downloads = (New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path",
    '}',
    '$d | ConvertTo-Json',
  ].join('\n')

  try {
    const raw = execFileSync(
      'powershell',
      ['-NonInteractive', '-NoProfile', '-Command', script],
      { encoding: 'utf-8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const parsed = JSON.parse(raw.trim()) as Record<string, string>

    return {
      Desktop:   parsed.Desktop   || naive('Desktop'),
      Documents: parsed.Documents || naive('Documents'),
      Downloads: parsed.Downloads || naive('Downloads'),
      Pictures:  parsed.Pictures  || naive('Pictures'),
      Music:     parsed.Music     || naive('Music'),
      Videos:    parsed.Videos    || naive('Videos'),
    }
  } catch {
    // Fallback: check for OneDrive redirect manually for Desktop at minimum
    const oneDriveDesktop = path.join(home, 'OneDrive', 'Desktop')
    return {
      Desktop:   fs.existsSync(oneDriveDesktop) ? oneDriveDesktop : naive('Desktop'),
      Documents: naive('Documents'),
      Downloads: naive('Downloads'),
      Pictures:  naive('Pictures'),
      Music:     naive('Music'),
      Videos:    naive('Videos'),
    }
  }
}

export function getSpecialFolders(): SpecialFolders {
  if (!_folders) _folders = buildFolders()
  return _folders
}

// ─── Path alias map ───────────────────────────────────────────────────────────
// Maps the "naive" path (what you'd guess from the home dir) to the real OS path.
// Used by validatePath() to silently redirect before any filesystem operation.

let _aliases: Map<string, string> | null = null

function buildAliases(): Map<string, string> {
  const home = homedir()
  const folders = getSpecialFolders()
  const map = new Map<string, string>()

  const pairs: [string, string][] = [
    [path.join(home, 'Desktop'),   folders.Desktop],
    [path.join(home, 'Documents'), folders.Documents],
    [path.join(home, 'Downloads'), folders.Downloads],
    [path.join(home, 'Pictures'),  folders.Pictures],
    [path.join(home, 'Music'),     folders.Music],
    [path.join(home, 'Videos'),    folders.Videos],
  ]

  for (const [naive, real] of pairs) {
    const n = path.normalize(naive)
    const r = path.normalize(real)
    if (n !== r) map.set(n, r)
  }

  return map
}

function getAliases(): Map<string, string> {
  if (!_aliases) _aliases = buildAliases()
  return _aliases
}

/**
 * Resolve a path through OS special-folder aliases.
 * If the path starts with a naive special-folder location (e.g. ~/Desktop)
 * but the real OS folder is elsewhere (e.g. ~/OneDrive/Desktop),
 * the path is transparently rewritten before the caller touches the filesystem.
 * No-op when no alias applies or on non-Windows platforms.
 */
export function resolveSpecialFolderAlias(absPath: string): string {
  const aliases = getAliases()
  if (aliases.size === 0) return absPath

  const normalized = path.normalize(absPath)
  for (const [naive, real] of aliases) {
    if (normalized === naive) return real
    if (normalized.startsWith(naive + path.sep)) {
      return real + normalized.slice(naive.length)
    }
  }
  return absPath
}

/** Reset cached state — for tests only. */
export function resetSpecialFolders(): void {
  _folders = null
  _aliases = null
}
