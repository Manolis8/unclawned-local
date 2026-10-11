import fs from 'fs'
import path from 'path'
import { validatePath, isBinaryFile } from './security.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EditFilePreview {
  resolvedPath: string
  oldStr: string          // the string that will actually be searched (may be normalized)
  newStr: string
  matchLine: number       // 1-indexed line where the first match starts
  matchCount: number      // 1 for normal edits; N for replace_all
  oldLineCount: number    // lines being replaced
  newLineCount: number    // lines replacing them
  oldStrPreview: string   // first 8 lines of old_str (for confirmation UI)
  newStrPreview: string   // first 8 lines of new_str
  wasNormalized: boolean  // true if trailing whitespace was stripped to find the match
  replaceAll: boolean     // true when all occurrences should be replaced
}

export interface EditFileResult {
  resolvedPath: string
  matchLine: number
  linesRemoved: number
  linesAdded: number
  bytesDelta: number      // positive = grew, negative = shrank
  diff: string            // unified-style diff of old_str → new_str
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export function previewEditFile(
  filePath: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): EditFilePreview {
  if (!oldStr) throw new Error('old_str cannot be empty.')

  const resolved = validatePath(filePath)

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: "${resolved}"\nTip: use find_file to locate the file first.`)
  }

  if (fs.statSync(resolved).isDirectory()) {
    throw new Error(`"${resolved}" is a directory, not a file.`)
  }

  if (isBinaryFile(resolved)) {
    throw new Error(`Cannot edit binary file: "${resolved}"`)
  }

  const raw = fs.readFileSync(resolved, 'utf-8')
  const content = normalizeLineEndings(raw)

  // First try exact match
  let effectiveOldStr = oldStr
  let wasNormalized = false
  let occurrences = countOccurrences(content, effectiveOldStr)

  // If no exact match, try with trailing whitespace normalized per line
  if (occurrences === 0) {
    const normalizedOld = normalizeTrailingWS(oldStr)
    const normalizedContent = normalizeTrailingWS(content)
    const normOccurrences = countOccurrences(normalizedContent, normalizedOld)
    if (normOccurrences > 0) {
      effectiveOldStr = normalizedOld
      wasNormalized = true
      occurrences = normOccurrences
    }
  }

  if (occurrences === 0) {
    const hint = buildNotFoundHint(content, oldStr)
    throw new Error(
      `old_str not found in "${path.basename(resolved)}".\n${hint}\n` +
      `Tip: copy the exact text from read_file output, including surrounding lines for uniqueness.`
    )
  }

  if (occurrences > 1 && !replaceAll) {
    const locations = findMatchLines(wasNormalized ? normalizeTrailingWS(content) : content, effectiveOldStr)
    throw new Error(
      `old_str matches ${occurrences} locations in "${path.basename(resolved)}" ` +
      `(lines ${locations.join(', ')}). ` +
      `Add more surrounding lines to make it unique, or pass replace_all: true to replace all occurrences.`
    )
  }

  // Find first match line number for the preview
  const searchIn = wasNormalized ? normalizeTrailingWS(content) : content
  const matchIndex = searchIn.indexOf(effectiveOldStr)
  // Use searchIn (not content) for line count: same line structure, correct character offsets
  const matchLine = searchIn.substring(0, matchIndex).split('\n').length

  const oldLines = effectiveOldStr.split('\n')
  const newLines = newStr.split('\n')
  const PREVIEW_LINES = 8

  return {
    resolvedPath: resolved,
    oldStr: effectiveOldStr,
    newStr,
    matchLine,
    matchCount: occurrences,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
    oldStrPreview: oldLines.slice(0, PREVIEW_LINES).join('\n') +
      (oldLines.length > PREVIEW_LINES ? `\n… (${oldLines.length - PREVIEW_LINES} more lines)` : ''),
    newStrPreview: newLines.slice(0, PREVIEW_LINES).join('\n') +
      (newLines.length > PREVIEW_LINES ? `\n… (${newLines.length - PREVIEW_LINES} more lines)` : ''),
    wasNormalized,
    replaceAll,
  }
}

// ─── Execute ─────────────────────────────────────────────────────────────────

export function executeEditFile(
  preview: EditFilePreview,
  newStr: string,
): EditFileResult {
  const { resolvedPath, oldStr, wasNormalized, replaceAll } = preview

  // Re-read the file — it must still match (stale check)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File was deleted since preview: "${resolvedPath}"`)
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8')
  const content = normalizeLineEndings(raw)

  const searchIn = wasNormalized ? normalizeTrailingWS(content) : content
  const occurrences = countOccurrences(searchIn, oldStr)

  if (occurrences === 0) {
    throw new Error(
      `File was modified since preview — old_str no longer found. ` +
      `Re-read the file and call edit_file again with current content.`
    )
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `File was modified since preview — old_str now matches ${occurrences} locations. ` +
      `Re-read and pick a more unique old_str.`
    )
  }

  // Build replacement using character-accurate position mapping
  let newContent: string
  if (replaceAll) {
    // Global replace — simple string split/join (wasNormalized not applicable for replaceAll)
    newContent = content.split(oldStr).join(newStr)
  } else if (wasNormalized) {
    const normContent = normalizeTrailingWS(content)
    const matchIdx = normContent.indexOf(oldStr)
    const origStart = normToOrigIdx(normContent, content, matchIdx)
    const origEnd = normToOrigIdx(normContent, content, matchIdx + oldStr.length)
    newContent = content.substring(0, origStart) + newStr + content.substring(origEnd)
  } else {
    const matchIdx = content.indexOf(oldStr)
    newContent = content.substring(0, matchIdx) + newStr + content.substring(matchIdx + oldStr.length)
  }

  // Preserve original line ending style (CRLF vs LF)
  const hadCRLF = raw.includes('\r\n')
  const finalContent = hadCRLF ? newContent.replace(/\n/g, '\r\n') : newContent

  // Atomic write: write to temp file, rename
  const tmpPath = resolvedPath + `.edit-tmp-${Date.now()}`
  try {
    fs.writeFileSync(tmpPath, finalContent, 'utf-8')
    // Verify temp file is readable
    const check = fs.readFileSync(tmpPath, 'utf-8')
    if (check.length !== finalContent.length) {
      throw new Error('Temp file write verification failed (size mismatch).')
    }
    fs.renameSync(tmpPath, resolvedPath)
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath) } catch {}
    throw err
  }

  // Post-write verification: confirm new content is actually in the saved file
  if (newStr.length > 0) {
    const verifyRaw = fs.readFileSync(resolvedPath, 'utf-8')
    const verifyNorm = normalizeLineEndings(verifyRaw)
    if (!verifyNorm.includes(normalizeLineEndings(newStr))) {
      throw new Error('Post-edit verification failed — new content was not found in the saved file. The disk may be full or there may be a filesystem error.')
    }
  }

  const bytesBefore = Buffer.byteLength(raw, 'utf-8')
  const bytesAfter  = Buffer.byteLength(finalContent, 'utf-8')

  return {
    resolvedPath,
    matchLine:   preview.matchLine,
    linesRemoved: preview.oldLineCount,
    linesAdded:   preview.newLineCount,
    bytesDelta:   bytesAfter - bytesBefore,
    diff:         computeInlineDiff(preview.oldStr, preview.newStr, preview.matchLine, preview.replaceAll),
  }
}

// ─── Format helper ────────────────────────────────────────────────────────────

export function formatEditFileResult(r: EditFileResult): string {
  const delta = r.bytesDelta > 0 ? `+${r.bytesDelta}B` : `${r.bytesDelta}B`
  const lineChange = r.linesAdded === r.linesRemoved
    ? `${r.linesAdded} line(s) replaced in-place`
    : `${r.linesRemoved} line(s) → ${r.linesAdded} line(s) (${delta})`
  return `Edited: ${r.resolvedPath}\nAt line ${r.matchLine}: ${lineChange}\n\n${r.diff}`
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const editToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: [
        'Make a targeted edit to a file by replacing an exact string with new content.',
        'Safer than write_file(overwrite) because only the specified section changes.',
        'ALWAYS call read_file first to get the exact text to put in old_str.',
        'old_str MUST appear exactly once in the file — include enough surrounding lines to make it unique.',
        'new_str replaces old_str exactly. Empty new_str deletes the matched block.',
        'Use this for: editing code, config files, CSV rows, any targeted change.',
        'Use write_file(overwrite) only when replacing the whole file.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to edit.',
          },
          old_str: {
            type: 'string',
            description: [
              'The exact text to find and replace. Must appear exactly once in the file.',
              'Include 3–5 lines of surrounding context to ensure uniqueness.',
              'Copy verbatim from read_file output — do not paraphrase or reformat.',
            ].join(' '),
          },
          new_str: {
            type: 'string',
            description: 'The text that replaces old_str. Can be empty to delete the matched block.',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence of old_str in the file instead of requiring it to be unique. Default: false. Use for variable renames or repeated patterns.',
          },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
]

// ─── Internal helpers ─────────────────────────────────────────────────────────

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function normalizeTrailingWS(s: string): string {
  return s.split('\n').map(l => l.trimEnd()).join('\n')
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while (true) {
    idx = haystack.indexOf(needle, idx)
    if (idx === -1) break
    count++
    idx += needle.length
  }
  return count
}

function findMatchLines(content: string, needle: string): number[] {
  const lines: number[] = []
  let idx = 0
  while (true) {
    idx = content.indexOf(needle, idx)
    if (idx === -1) break
    lines.push(content.substring(0, idx).split('\n').length)
    idx += needle.length
  }
  return lines
}

// Map a character index in normContent back to the corresponding index in origContent.
// normalizeTrailingWS strips trailing whitespace per line — line count and start-of-line
// positions are preserved, so we walk line by line to accumulate the offset delta.
function normToOrigIdx(normContent: string, origContent: string, normIdx: number): number {
  const normLines = normContent.split('\n')
  const origLines = origContent.split('\n')
  let ni = 0
  let oi = 0
  for (let i = 0; i < normLines.length; i++) {
    if (ni + normLines[i].length >= normIdx) return oi + (normIdx - ni)
    ni += normLines[i].length + 1   // +1 for '\n'
    oi += origLines[i].length + 1
  }
  return oi
}

// Produce a compact unified-style diff showing what old_str → new_str looks like.
// For replace_all we skip the positional header since there are multiple match sites.
function computeInlineDiff(oldStr: string, newStr: string, matchLine: number, replaceAll: boolean): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const header = replaceAll
    ? `@@ (all occurrences) -${oldLines.length} line(s) +${newLines.length} line(s) @@`
    : `@@ -${matchLine},${oldLines.length} +${matchLine},${newLines.length} @@`
  const removed = oldLines.map(l => `-${l}`)
  const added   = newLines.map(l => `+${l}`)
  return [header, ...removed, ...added].join('\n')
}

function buildNotFoundHint(content: string, oldStr: string): string {
  // Try to give a useful hint: find the first line of old_str in the file
  const firstLine = oldStr.split('\n')[0].trim()
  if (!firstLine) return ''

  const contentLines = content.split('\n')
  const closestIdx = contentLines.findIndex(l => l.includes(firstLine))
  if (closestIdx === -1) {
    // Try a fragment of the first line
    const fragment = firstLine.substring(0, Math.min(20, firstLine.length))
    const fragIdx = contentLines.findIndex(l => l.includes(fragment))
    if (fragIdx !== -1) {
      return `First line of old_str found at line ${fragIdx + 1} but full old_str didn't match — check indentation and surrounding content.`
    }
    return `First line of old_str not found in file. Double-check the text is copied exactly from read_file output.`
  }
  return `First line of old_str found at line ${closestIdx + 1} but full old_str didn't match — the following lines may differ.`
}
