import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type FileCategory =
  | 'data'
  | 'writing'
  | 'code'
  | 'design'
  | 'presentation'
  | 'config'
  | 'archive'
  | 'other'

export type WorkTypeInference =
  | 'developer'
  | 'analyst'
  | 'writer'
  | 'designer'
  | 'operator'
  | 'mixed'

// ─── Load file-type dictionary ────────────────────────────────────────────────

let _fileTypeMap: Map<string, FileCategory> | null = null

function getFileTypeMap(): Map<string, FileCategory> {
  if (_fileTypeMap) return _fileTypeMap

  const raw = readFileSync(join(__dirname, '../../data/file-type-categories.json'), 'utf8')
  const data: Record<string, string[]> = JSON.parse(raw)

  _fileTypeMap = new Map()
  for (const [category, extensions] of Object.entries(data)) {
    for (const ext of extensions) {
      _fileTypeMap.set(ext.toLowerCase(), category as FileCategory)
    }
  }
  return _fileTypeMap
}

// ─── classifyFileType ─────────────────────────────────────────────────────────

export function classifyFileType(extension: string): FileCategory {
  const map = getFileTypeMap()
  const lower = extension.toLowerCase()
  const withDot = lower.startsWith('.') ? lower : `.${lower}`
  return map.get(withDot) ?? 'other'
}

// ─── extractFolderName ────────────────────────────────────────────────────────
//
// Returns the immediate parent folder name from a file path.
// Never returns a full path — privacy design: store folder names only.
//
// "C:\Users\manol\Documents\Projects\report.xlsx" → "Projects"
// "/home/user/code/my-app/src/index.ts"           → "src"
// "report.xlsx"                                    → ""

export function extractFolderName(filePath: string): string {
  if (!filePath) return ''

  // Normalize separators
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/')

  // parts[-1] = filename, parts[-2] = immediate parent folder
  if (parts.length < 2) return ''
  const folder = parts[parts.length - 2]
  return folder ?? ''
}

// ─── extractExtension ─────────────────────────────────────────────────────────

export function extractExtension(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dotIdx = name.lastIndexOf('.')
  // dotIdx === 0 means .gitignore-style (filename IS the "extension") — no extension
  if (dotIdx <= 0 || dotIdx === name.length - 1) return ''
  return name.slice(dotIdx).toLowerCase()
}

// ─── inferWorkType ────────────────────────────────────────────────────────────
//
// Derives work type from accumulated file category counts.
// Called by the profile builder after enough file accesses have been recorded.

export function inferWorkType(byCategoryCount: Record<string, number>): WorkTypeInference {
  const total = Object.values(byCategoryCount).reduce((s, n) => s + n, 0)
  if (total === 0) return 'mixed'

  const frac = (cat: string) => (byCategoryCount[cat] ?? 0) / total

  const code = frac('code')
  const data = frac('data')
  const writing = frac('writing')
  const design = frac('design')

  // Dominant category threshold: > 40%
  if (code > 0.40)    return 'developer'
  if (data > 0.40)    return 'analyst'
  if (writing > 0.40) return 'writer'
  if (design > 0.40)  return 'designer'

  // Combined signals
  if (code + data > 0.55) return 'developer'
  if (data + writing > 0.55) return 'analyst'

  return 'mixed'
}
