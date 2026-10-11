import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import pm from 'picomatch'
import { validatePath, isBinaryFile, formatBytes } from './security.js'
import type { ReadFileResult, ListDirectoryResult, DirEntry, FindFileResult, FileMatch, SearchResult, SearchFileResult, SearchLineGroup } from './types.js'

const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 500
const MAX_DIR_ENTRIES = 150
const MAX_FIND_RESULTS = 20
const MAX_FIND_DEPTH = 6
const LARGE_FILE_BYTES = 10 * 1024 * 1024  // 10 MB — load fully below this

// Directories skipped by find_file and list_directory (large, system, or irrelevant)
const SKIP_DIRS = new Set([
  'node_modules', '$RECYCLE.BIN', 'AppData', '.git', '.svn',
  '__pycache__', '.cache', 'Library', 'Applications', '.Trash',
  'System Volume Information', 'PerfLogs', 'Recovery',
])

// ─── read_file ────────────────────────────────────────────────────────────────

export function readFile(
  filePath: string,
  startLine = 1,
  endLine?: number
): ReadFileResult {
  const resolved = validatePath(filePath)

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: "${resolved}"\nTip: use find_file to search for a file by name.`)
  }

  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    throw new Error(`"${resolved}" is a directory. Use list_directory to see its contents.`)
  }

  if (isBinaryFile(resolved)) {
    const ext = path.extname(resolved).toLowerCase()
    throw new Error(
      `Cannot read binary file (${ext} format). ` +
      `Describe what you need from this file and I'll find another approach.`
    )
  }

  const from = Math.max(1, startLine)
  const limit = endLine
    ? Math.min(endLine - from + 1, MAX_READ_LINES)
    : DEFAULT_READ_LINES

  let allLines: string[]

  if (stat.size > LARGE_FILE_BYTES) {
    // Large file: read only what we need using a sync line scan to avoid loading into memory
    allLines = readLinesSync(resolved, from, from + Math.min(limit, MAX_READ_LINES) - 1)
    // We don't know totalLines without reading the whole file — estimate
    const selected = allLines
    const wasTruncated = allLines.length >= limit
    return {
      content: selected.join('\n'),
      totalLines: -1,  // unknown for large files
      wasTruncated,
      resolvedPath: resolved,
      startLine: from,
      endLine: from + selected.length - 1,
    }
  }

  // Normal path: load full file, normalize line endings (handles Windows CRLF)
  const raw = fs.readFileSync(resolved, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  allLines = raw.split('\n')
  const totalLines = allLines.length

  const maxEnd = from + MAX_READ_LINES - 1
  const to = endLine
    ? Math.min(endLine, maxEnd, totalLines)
    : Math.min(from + DEFAULT_READ_LINES - 1, totalLines)

  const selected = allLines.slice(from - 1, to)
  const wasTruncated = to < totalLines

  return {
    content: selected.join('\n'),
    totalLines,
    wasTruncated,
    resolvedPath: resolved,
    startLine: from,
    endLine: to,
  }
}

// Reads specific lines from a large file without loading the whole file into memory
function readLinesSync(filePath: string, fromLine: number, toLine: number): string[] {
  const CHUNK = 64 * 1024  // 64 KB read chunks
  const fd = fs.openSync(filePath, 'r')
  const out: string[] = []
  let lineNum = 1
  let leftover = ''
  let offset = 0
  const buf = Buffer.alloc(CHUNK)

  try {
    while (lineNum <= toLine) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      const chunk = leftover + buf.slice(0, bytesRead).toString('utf-8')
      const parts = chunk.split('\n')
      leftover = parts.pop() ?? ''
      for (const line of parts) {
        if (lineNum >= fromLine && lineNum <= toLine) {
          out.push(line.replace(/\r$/, ''))
        }
        lineNum++
        if (lineNum > toLine) break
      }
    }
    // Handle last line with no trailing newline
    if (leftover && lineNum >= fromLine && lineNum <= toLine) {
      out.push(leftover.replace(/\r$/, ''))
    }
  } finally {
    fs.closeSync(fd)
  }

  return out
}

// ─── list_directory ───────────────────────────────────────────────────────────

export function listDirectory(
  dirPath: string,
  depth = 1,
  filter?: string
): ListDirectoryResult {
  const resolved = validatePath(dirPath)

  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory not found: "${resolved}"`)
  }

  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) {
    throw new Error(`"${resolved}" is a file. Use read_file to read its contents.`)
  }

  const safeDepth = Math.min(Math.max(1, depth), 3)
  const entries: DirEntry[] = []

  collectEntries(resolved, resolved, safeDepth, 0, filter, entries)

  // Sort: dirs first, then files, both alphabetically
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const wasCapped = entries.length > MAX_DIR_ENTRIES

  return {
    entries: entries.slice(0, MAX_DIR_ENTRIES),
    resolvedPath: resolved,
    totalEntries: entries.length,
    wasCapped,
  }
}

function collectEntries(
  baseDir: string,
  currentDir: string,
  maxDepth: number,
  currentDepth: number,
  filter: string | undefined,
  out: DirEntry[]
): void {
  if (out.length >= MAX_DIR_ENTRIES * 2) return

  let items: string[]
  try {
    items = fs.readdirSync(currentDir)
  } catch {
    return
  }

  for (const item of items) {
    // Skip hidden items and known system/tooling directories
    if (item.startsWith('.') || SKIP_DIRS.has(item)) continue

    const fullPath = path.join(currentDir, item)
    let stat: fs.Stats
    try {
      stat = fs.statSync(fullPath)
    } catch {
      continue
    }

    const isDir = stat.isDirectory()
    const ext = isDir ? null : path.extname(item).toLowerCase() || null
    const relativePath = path.relative(baseDir, fullPath)

    // Apply filter to files only
    if (filter && !isDir) {
      if (!matchesGlob(item, relativePath, filter)) continue
    }

    out.push({
      name: item,
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : stat.size,
      sizeLabel: isDir ? '' : formatBytes(stat.size),
      modifiedAt: stat.mtime.toISOString().split('T')[0],
      extension: ext,
      relativePath,
    })

    if (isDir && currentDepth < maxDepth - 1) {
      collectEntries(baseDir, fullPath, maxDepth, currentDepth + 1, filter, out)
    }
  }
}

// ─── find_file ────────────────────────────────────────────────────────────────

export function findFile(
  pattern: string,
  searchDir?: string
): FindFileResult {
  const resolvedDir = searchDir ? validatePath(searchDir) : homedir()

  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Search directory not found: "${resolvedDir}"`)
  }

  const matches: FileMatch[] = []
  searchRecursive(resolvedDir, resolvedDir, pattern, 0, matches)

  // Sort newest first
  matches.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))

  return {
    matches: matches.slice(0, MAX_FIND_RESULTS),
    searchDir: resolvedDir,
    pattern,
    totalFound: matches.length,
  }
}

function searchRecursive(
  dir: string,
  baseDir: string,
  pattern: string,
  depth: number,
  out: FileMatch[]
): void {
  if (depth > MAX_FIND_DEPTH || out.length >= MAX_FIND_RESULTS * 3) return

  let items: string[]
  try {
    items = fs.readdirSync(dir)
  } catch {
    return
  }

  for (const item of items) {
    if (item.startsWith('.') || SKIP_DIRS.has(item)) continue

    const fullPath = path.join(dir, item)
    let stat: fs.Stats
    try {
      stat = fs.statSync(fullPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      searchRecursive(fullPath, baseDir, pattern, depth + 1, out)
    } else {
      const relativePath = path.relative(baseDir, fullPath)
      if (matchesGlob(item, relativePath, pattern)) {
        out.push({
          path: fullPath,
          name: item,
          size: stat.size,
          sizeLabel: formatBytes(stat.size),
          modifiedAt: stat.mtime.toISOString().split('T')[0],
        })
      }
    }
  }
}

// Glob matching via picomatch.
// If pattern contains path separators or **, match against full relative path.
// Otherwise match against filename only (simple "find my file" UX).
function matchesGlob(filename: string, relativePath: string, pattern: string): boolean {
  const isPathPattern = pattern.includes('/') || pattern.includes('\\') || pattern.includes('**')
  const target = isPathPattern ? relativePath.replace(/\\/g, '/') : filename
  return pm(pattern, { nocase: true, dot: false })(target)
}

// ─── Format helpers for agent output ─────────────────────────────────────────

export function formatReadFileResult(r: ReadFileResult): string {
  const totalLabel = r.totalLines === -1 ? 'large file' : `of ${r.totalLines}`
  const header = [
    `File: ${r.resolvedPath}`,
    `Lines ${r.startLine}–${r.endLine} ${totalLabel}`,
  ].join(' | ')

  // Prefix each line with its 1-indexed line number (tab-separated, like Claude Code)
  const numbered = r.content.split('\n')
    .map((line, i) => `${r.startLine + i}\t${line}`)
    .join('\n')

  let out = `${header}\n${'─'.repeat(60)}\n${numbered}`

  if (r.wasTruncated) {
    const totalNote = r.totalLines === -1 ? '' : ` File has ${r.totalLines} lines total.`
    out += `\n${'─'.repeat(60)}\n[Truncated.${totalNote} Use start_line=${r.endLine + 1} to continue reading.]`
  }

  return out
}

export function formatListDirectoryResult(r: ListDirectoryResult): string {
  const lines: string[] = [`Contents of: ${r.resolvedPath}`]
  if (r.wasCapped) lines.push(`(showing first ${MAX_DIR_ENTRIES} of ${r.totalEntries} entries)`)
  lines.push('─'.repeat(60))

  for (const e of r.entries) {
    const indent = '  '.repeat(e.relativePath.split(path.sep).length - 1)
    const label = e.type === 'dir'
      ? `📁 ${e.name}/`
      : `📄 ${e.name}  ${e.sizeLabel}  ${e.modifiedAt}`
    lines.push(indent + label)
  }

  if (r.entries.length === 0) lines.push('  (empty directory)')

  return lines.join('\n')
}

export function formatFindFileResult(r: FindFileResult): string {
  if (r.matches.length === 0) {
    return `No files matching "${r.pattern}" found under ${r.searchDir}.\nTip: try a broader pattern like "*${r.pattern.replace(/\*/g, '')}*"`
  }

  const lines: string[] = [
    `Found ${r.matches.length}${r.totalFound > MAX_FIND_RESULTS ? `+ (showing top ${MAX_FIND_RESULTS})` : ''} file(s) matching "${r.pattern}":`,
    '─'.repeat(60),
  ]

  for (const m of r.matches) {
    lines.push(`📄 ${m.path}  ${m.sizeLabel}  modified ${m.modifiedAt}`)
  }

  return lines.join('\n')
}

// ─── search_in_file ───────────────────────────────────────────────────────────

const MAX_SEARCH_RESULTS = 50
const MAX_SEARCH_FILE_SIZE = 5 * 1024 * 1024   // skip files over 5 MB in dir search
const MAX_SEARCH_DIR_FILES = 500                 // stop walking after this many files checked

export interface SearchOptions {
  contextLines?: number       // lines of context around each match (default: 2)
  isRegex?: boolean           // treat pattern as regex (default: false)
  maxResults?: number         // max total matches (default: 50)
  extensions?: string[]       // e.g. ['ts','js'] — only for directory search
  caseSensitive?: boolean     // default false (case-insensitive)
  outputMode?: 'content' | 'files_with_matches' | 'count'
  multiline?: boolean         // regex spans multiple lines (requires isRegex: true)
}

export function searchInFile(
  filePath: string,
  pattern: string,
  opts: SearchOptions = {},
): SearchResult {
  const {
    contextLines = 2, isRegex = false, maxResults = MAX_SEARCH_RESULTS, extensions,
    caseSensitive = false, outputMode, multiline = false,
  } = opts

  const resolved = validatePath(filePath)

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path not found: "${resolved}"`)
  }

  const stat = fs.statSync(resolved)

  // Compile matcher — use multiline path when requested
  const useMultiline = multiline && isRegex
  const matcher = useMultiline ? null : buildMatcher(pattern, isRegex, caseSensitive)

  let fileResults: SearchFileResult[] = []
  let totalMatchCount = 0
  let totalFileCount = 0
  let wasCapped = false

  if (stat.isDirectory()) {
    const files = collectSearchableFiles(resolved, extensions)
    totalFileCount = files.length

    for (const fp of files) {
      if (totalMatchCount >= maxResults) { wasCapped = true; break }
      const remaining = maxResults - totalMatchCount
      const fr = useMultiline
        ? searchSingleFileMultiline(fp, pattern, caseSensitive, contextLines, remaining)
        : searchSingleFile(fp, matcher!, contextLines, remaining)
      if (fr && fr.matchCount > 0) {
        fileResults.push(fr)
        totalMatchCount += fr.matchCount
        if (fr.wasCapped) wasCapped = true
      }
    }
  } else {
    if (isBinaryFile(resolved)) {
      throw new Error(`Cannot search binary file: "${resolved}"`)
    }
    const fr = useMultiline
      ? searchSingleFileMultiline(resolved, pattern, caseSensitive, contextLines, maxResults)
      : searchSingleFile(resolved, matcher!, contextLines, maxResults)
    if (fr) {
      fileResults = [fr]
      totalMatchCount = fr.matchCount
      if (fr.wasCapped) wasCapped = true
    }
    totalFileCount = 1
  }

  return { pattern, isRegex, fileResults, totalMatchCount, totalFileCount, wasCapped, outputMode }
}

function buildMatcher(pattern: string, isRegex: boolean, caseSensitive = false): (line: string) => boolean {
  if (isRegex) {
    let re: RegExp
    try {
      re = new RegExp(pattern, caseSensitive ? '' : 'i')
    } catch {
      throw new Error(`Invalid regex pattern: "${pattern}"`)
    }
    return (line) => re.test(line)
  }
  if (caseSensitive) {
    return (line) => line.includes(pattern)
  }
  const lower = pattern.toLowerCase()
  return (line) => line.toLowerCase().includes(lower)
}

function searchSingleFileMultiline(
  filePath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxResults: number,
): SearchFileResult | null {
  let content: string
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_SEARCH_FILE_SIZE) return null
    content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  } catch {
    return null
  }

  let re: RegExp
  try {
    // g=global, m=multiline anchors, s=dotAll (. matches \n)
    re = new RegExp(pattern, caseSensitive ? 'gms' : 'gmsi')
  } catch {
    throw new Error(`Invalid regex pattern: "${pattern}"`)
  }

  const lines = content.split('\n')
  const matchLineNums: number[] = []
  let match: RegExpExecArray | null

  while ((match = re.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length
    // Deduplicate consecutive matches on same line
    if (matchLineNums[matchLineNums.length - 1] !== lineNum) {
      matchLineNums.push(lineNum)
    }
    if (matchLineNums.length >= maxResults) break
    if (match[0].length === 0) re.lastIndex++  // prevent infinite loop on zero-width match
  }

  if (matchLineNums.length === 0) return { filePath, groups: [], matchCount: 0, wasCapped: false }

  const wasCapped = matchLineNums.length >= maxResults
  const groups = buildGroups(lines, matchLineNums, contextLines)
  return { filePath, groups, matchCount: matchLineNums.length, wasCapped }
}

function searchSingleFile(
  filePath: string,
  matcher: (line: string) => boolean,
  contextLines: number,
  maxResults: number,
): SearchFileResult | null {
  let content: string
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_SEARCH_FILE_SIZE) return null
    content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  } catch {
    return null
  }

  const lines = content.split('\n')
  const matchLineNums: number[] = []   // 1-indexed

  for (let i = 0; i < lines.length; i++) {
    if (matcher(lines[i])) {
      matchLineNums.push(i + 1)
      if (matchLineNums.length >= maxResults) break
    }
  }

  if (matchLineNums.length === 0) return { filePath, groups: [], matchCount: 0, wasCapped: false }

  const wasCapped = matchLineNums.length >= maxResults

  // Merge overlapping context ranges into groups
  const groups = buildGroups(lines, matchLineNums, contextLines)

  return { filePath, groups, matchCount: matchLineNums.length, wasCapped }
}

function buildGroups(
  lines: string[],
  matchLineNums: number[],  // 1-indexed, sorted ascending
  contextLines: number,
): SearchLineGroup[] {
  // Build raw ranges
  const ranges: Array<{ start: number; end: number }> = matchLineNums.map(n => ({
    start: Math.max(1, n - contextLines),
    end:   Math.min(lines.length, n + contextLines),
  }))

  // Merge overlapping / adjacent ranges
  const merged: Array<{ start: number; end: number; matchNums: Set<number> }> = []
  let matchIdx = 0

  for (const range of ranges) {
    const matchNum = matchLineNums[matchIdx++]
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
      last.matchNums.add(matchNum)
    } else {
      merged.push({ start: range.start, end: range.end, matchNums: new Set([matchNum]) })
    }
  }

  return merged.map(({ start, end, matchNums }) => ({
    startLine: start,
    lines: lines.slice(start - 1, end).map((content, i) => ({
      lineNumber: start + i,
      content,
      isMatch: matchNums.has(start + i),
    })),
  }))
}

function collectSearchableFiles(dirPath: string, extensions?: string[]): string[] {
  const results: string[] = []
  const extSet = extensions?.length
    ? new Set(extensions.map(e => (e.startsWith('.') ? e : '.' + e).toLowerCase()))
    : null

  walkForSearch(dirPath, extSet, results, 0)
  return results
}

function walkForSearch(dir: string, extSet: Set<string> | null, out: string[], depth: number): void {
  if (depth > MAX_FIND_DEPTH || out.length >= MAX_SEARCH_DIR_FILES) return

  let items: string[]
  try { items = fs.readdirSync(dir) } catch { return }

  for (const item of items) {
    if (item.startsWith('.') || SKIP_DIRS.has(item)) continue
    const full = path.join(dir, item)
    let stat: fs.Stats
    try { stat = fs.statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      walkForSearch(full, extSet, out, depth + 1)
    } else {
      if (stat.size > MAX_SEARCH_FILE_SIZE) continue
      if (isBinaryFile(full)) continue
      if (extSet) {
        const ext = path.extname(item).toLowerCase()
        if (!extSet.has(ext)) continue
      }
      out.push(full)
    }
  }
}

export function formatSearchResult(r: SearchResult): string {
  if (r.totalMatchCount === 0) {
    const scope = r.fileResults.length > 0 ? r.fileResults[0].filePath : 'given path'
    return `No matches for "${r.pattern}" in ${scope}.`
  }

  const SEP = '─'.repeat(60)
  const out: string[] = []

  // files_with_matches: return only file paths
  if (r.outputMode === 'files_with_matches') {
    out.push(`${r.fileResults.length} file(s) matching "${r.pattern}":`)
    for (const fr of r.fileResults) out.push(fr.filePath)
    if (r.wasCapped) out.push(`[Capped — use a more specific pattern to see all results]`)
    return out.join('\n')
  }

  // count: return match count per file
  if (r.outputMode === 'count') {
    out.push(`Match counts for "${r.pattern}":`)
    for (const fr of r.fileResults) out.push(`${fr.matchCount}\t${fr.filePath}`)
    out.push(`Total: ${r.totalMatchCount} in ${r.fileResults.length} file(s)`)
    return out.join('\n')
  }

  // content (default): full context output
  if (r.fileResults.length === 1) {
    const fr = r.fileResults[0]
    const capNote = fr.wasCapped ? ` (showing first ${fr.matchCount})` : ''
    out.push(`${fr.matchCount} match(es)${capNote} for "${r.pattern}" in ${fr.filePath}`)
    out.push(SEP)
    appendFileGroups(out, fr)
  } else {
    const capNote = r.wasCapped ? ` (capped at ${r.totalMatchCount})` : ''
    out.push(`${r.totalMatchCount} match(es)${capNote} across ${r.fileResults.length} file(s) for "${r.pattern}"`)

    for (const fr of r.fileResults) {
      out.push(SEP)
      out.push(`${fr.filePath} (${fr.matchCount} match${fr.matchCount !== 1 ? 'es' : ''})`)
      appendFileGroups(out, fr)
    }
  }

  if (r.wasCapped) {
    out.push(SEP)
    out.push(`[Results capped at ${r.totalMatchCount}. Use a more specific pattern or add file_extensions to narrow the search.]`)
  }

  return out.join('\n')
}

function appendFileGroups(out: string[], fr: SearchFileResult): void {
  const SEP = '─'.repeat(60)
  for (const group of fr.groups) {
    for (const line of group.lines) {
      const num = String(line.lineNumber).padStart(4)
      const marker = line.isMatch ? '▶' : ' '
      out.push(`${num} ${marker} ${line.content}`)
    }
    out.push(SEP)
  }
}

// ─── get_file_info ────────────────────────────────────────────────────────────

export interface FileInfo {
  resolvedPath: string
  exists: boolean
  isDirectory: boolean
  isBinary: boolean
  size: number
  sizeLabel: string
  lineCount: number | null
  encoding: 'utf-8' | 'utf-16-le' | 'utf-16-be' | 'utf-8-bom' | 'binary' | 'unknown'
  lineEnding: 'CRLF' | 'LF' | 'CR' | 'mixed' | 'unknown'
  createdAt: string
  modifiedAt: string
  extension: string | null
  permissions: string
}

function detectEncoding(buf: Buffer): FileInfo['encoding'] {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf-8-bom'
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf-16-le'
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf-16-be'
  // No BOM — scan 512 bytes for null bytes
  const sample = buf.slice(0, 512)
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return 'binary'
  }
  return 'utf-8'
}

function detectLineEnding(buf: Buffer): FileInfo['lineEnding'] {
  const sample = buf.slice(0, 8192)
  let crlf = 0, lf = 0, cr = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0x0D) {  // \r
      if (i + 1 < sample.length && sample[i + 1] === 0x0A) { crlf++; i++ }
      else cr++
    } else if (sample[i] === 0x0A) {
      lf++
    }
  }
  const total = crlf + lf + cr
  if (total === 0) return 'unknown'
  if (crlf === total) return 'CRLF'
  if (lf === total) return 'LF'
  if (cr === total) return 'CR'
  return 'mixed'
}

function formatPermissions(stat: import('fs').Stats): string {
  if (process.platform === 'win32') {
    const flags: string[] = []
    if (!(stat.mode & 0o200)) flags.push('ReadOnly')
    else flags.push('ReadWrite')
    return flags.join(', ')
  }
  // Unix rwxrwxrwx
  const m = stat.mode
  const bits = ['r', 'w', 'x']
  let out = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let b = 2; b >= 0; b--) {
      out += (m >> (shift + b)) & 1 ? bits[2 - b] : '-'
    }
  }
  return out
}

export function getFileInfo(filePath: string): FileInfo {
  const expanded = filePath.startsWith('~') ? path.join(homedir(), filePath.slice(1)) : filePath
  const resolved = path.resolve(expanded)
  validatePath(resolved)

  if (!fs.existsSync(resolved)) {
    return {
      resolvedPath: resolved, exists: false, isDirectory: false,
      isBinary: false, size: 0, sizeLabel: '0 B', lineCount: null,
      encoding: 'unknown', lineEnding: 'unknown',
      createdAt: '', modifiedAt: '', extension: path.extname(resolved) || null,
      permissions: '',
    }
  }

  const stat = fs.statSync(resolved)
  const isDirectory = stat.isDirectory()
  const ext = path.extname(resolved) || null

  if (isDirectory) {
    return {
      resolvedPath: resolved, exists: true, isDirectory: true,
      isBinary: false, size: 0, sizeLabel: '0 B', lineCount: null,
      encoding: 'unknown', lineEnding: 'unknown',
      createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString(),
      extension: null, permissions: formatPermissions(stat),
    }
  }

  // Read first 8KB for detection — don't load full file
  const PROBE_SIZE = 8192
  let probeBuf: Buffer
  let fd: number | null = null
  try {
    fd = fs.openSync(resolved, 'r')
    probeBuf = Buffer.alloc(Math.min(PROBE_SIZE, stat.size))
    fs.readSync(fd, probeBuf, 0, probeBuf.length, 0)
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch {}
  }

  const encoding = detectEncoding(probeBuf)
  const isBinary = encoding === 'binary'
  const lineEnding = isBinary ? 'unknown' : detectLineEnding(probeBuf)

  // Line count — only for text files under 1MB
  let lineCount: number | null = null
  if (!isBinary && stat.size < 1024 * 1024) {
    try {
      const content = fs.readFileSync(resolved)
      let n = 0
      for (let i = 0; i < content.length; i++) {
        if (content[i] === 0x0A) n++
      }
      // If file doesn't end with \n, add 1 for the last line
      lineCount = content.length > 0 && content[content.length - 1] !== 0x0A ? n + 1 : n
    } catch {}
  }

  return {
    resolvedPath: resolved,
    exists: true,
    isDirectory: false,
    isBinary,
    size: stat.size,
    sizeLabel: formatBytes(stat.size),
    lineCount,
    encoding,
    lineEnding,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    extension: ext,
    permissions: formatPermissions(stat),
  }
}

export function formatFileInfo(r: FileInfo): string {
  if (!r.exists) return `File not found: ${r.resolvedPath}`
  if (r.isDirectory) {
    return [
      `Path: ${r.resolvedPath}`,
      `Type: directory`,
      `Created:  ${r.createdAt}`,
      `Modified: ${r.modifiedAt}`,
      `Permissions: ${r.permissions}`,
    ].join('\n')
  }
  const lines = [
    `Path: ${r.resolvedPath}`,
    `Type: ${r.isBinary ? 'binary file' : 'text file'}`,
    `Size: ${r.sizeLabel} (${r.size} bytes)`,
    `Lines: ${r.lineCount !== null ? r.lineCount : '(binary or >1MB)'}`,
    `Encoding: ${r.encoding}`,
    `Line endings: ${r.lineEnding}`,
    `Extension: ${r.extension ?? '(none)'}`,
    `Created:  ${r.createdAt}`,
    `Modified: ${r.modifiedAt}`,
    `Permissions: ${r.permissions}`,
  ]
  if (r.size > 5 * 1024 * 1024) {
    lines.push(`\n⚠ Large file (${r.sizeLabel}). Use start_line / end_line with read_file to read specific sections.`)
  }
  return lines.join('\n')
}
