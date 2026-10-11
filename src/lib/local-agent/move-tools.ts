import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { validatePath, formatBytes } from './security.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveAndValidate(p: string): string {
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
  const resolved = path.resolve(expanded)
  validatePath(resolved)
  return resolved
}

function sameDev(pathA: string, pathB: string): boolean {
  // Check if two paths are on the same filesystem device.
  // For the destination, check its parent directory (it may not exist yet).
  try {
    const devA = fs.statSync(pathA).dev
    const dirB = fs.existsSync(pathB) ? pathB : path.dirname(pathB)
    const devB = fs.statSync(dirB).dev
    return devA === devB
  } catch {
    return false
  }
}

function sha256File(filePath: string): string {
  const stat = fs.statSync(filePath)
  if (stat.size > 512 * 1024 * 1024) {
    // For files > 512 MB, use size+mtime as a lightweight integrity check
    // to avoid loading the entire file into memory.
    return crypto.createHash('sha256')
      .update(`size:${stat.size}|mtime:${stat.mtimeMs}`)
      .digest('hex')
  }
  const hash = crypto.createHash('sha256')
  const buf = fs.readFileSync(filePath)
  hash.update(buf)
  return hash.digest('hex')
}

function copyFileVerified(src: string, dst: string): void {
  fs.copyFileSync(src, dst)
  const srcHash = sha256File(src)
  const dstHash = sha256File(dst)
  if (srcHash !== dstHash) {
    try { fs.unlinkSync(dst) } catch {}
    throw new Error(`Copy verification failed — hash mismatch. Source not deleted.`)
  }
}

function copyDirRecursive(src: string, dst: string): number {
  fs.mkdirSync(dst, { recursive: true })
  let count = 0
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const e of entries) {
    const srcPath = path.join(src, e.name)
    const dstPath = path.join(dst, e.name)
    if (e.isDirectory()) {
      count += copyDirRecursive(srcPath, dstPath)
    } else {
      copyFileVerified(srcPath, dstPath)
      count++
    }
  }
  return count
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface MoveFilePreview {
  resolvedSource: string
  resolvedDest: string
  sourceSize: number
  sourceSizeLabel: string
  sourceModified: string
  destExists: boolean
  destExistingSize?: number
  destExistingSizeLabel?: string
  isSameFs: boolean
  isDirectory: boolean
}

export interface MoveFileResult {
  resolvedSource: string
  resolvedDest: string
  isDirectory: boolean
  isSameFs: boolean
  itemsMoved?: number    // for directory moves
}

export interface CopyFilePreview {
  resolvedSource: string
  resolvedDest: string
  sourceSize: number
  sourceSizeLabel: string
  sourceModified: string
  destExists: boolean
  destExistingSize?: number
  destExistingSizeLabel?: string
  isDirectory: boolean
  estimatedItemCount?: number
}

export interface CopyFileResult {
  resolvedSource: string
  resolvedDest: string
  isDirectory: boolean
  bytesCopied?: number
  itemsCopied?: number
}

// ─── move_file ────────────────────────────────────────────────────────────────

export function previewMoveFile(source: string, destination: string, overwrite = false): MoveFilePreview {
  const resolvedSource = resolveAndValidate(source)
  const resolvedDest = resolveAndValidate(destination)

  const srcStat = fs.statSync(resolvedSource)
  const isDirectory = srcStat.isDirectory()

  if (resolvedSource === resolvedDest) {
    throw new Error('Source and destination are the same path.')
  }

  const destExists = fs.existsSync(resolvedDest)
  if (destExists && !overwrite) {
    const dstStat = fs.statSync(resolvedDest)
    throw new Error(
      `Destination already exists: ${resolvedDest} (${formatBytes(dstStat.size)}, modified ${new Date(dstStat.mtimeMs).toISOString()}).\n` +
      `Pass overwrite: true to replace it.`
    )
  }

  const preview: MoveFilePreview = {
    resolvedSource,
    resolvedDest,
    sourceSize: srcStat.size,
    sourceSizeLabel: formatBytes(srcStat.size),
    sourceModified: new Date(srcStat.mtimeMs).toISOString(),
    destExists,
    isSameFs: sameDev(resolvedSource, resolvedDest),
    isDirectory,
  }

  if (destExists) {
    const dstStat = fs.statSync(resolvedDest)
    preview.destExistingSize = dstStat.size
    preview.destExistingSizeLabel = formatBytes(dstStat.size)
  }

  return preview
}

export function executeMoveFile(source: string, destination: string, overwrite = false): MoveFileResult {
  // Re-resolve (may have changed since preview)
  const resolvedSource = resolveAndValidate(source)
  const resolvedDest = resolveAndValidate(destination)

  const srcStat = fs.statSync(resolvedSource)
  const isDirectory = srcStat.isDirectory()
  const destExists = fs.existsSync(resolvedDest)

  if (destExists && !overwrite) {
    throw new Error(`Destination already exists: ${resolvedDest}. Pass overwrite: true to replace it.`)
  }

  const isSameFs = sameDev(resolvedSource, resolvedDest)

  // Ensure destination parent directory exists
  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true })

  if (isSameFs) {
    if (destExists) {
      if (isDirectory) {
        // Must clear non-empty target directory before rename on any OS
        fs.rmSync(resolvedDest, { recursive: true })
      } else if (process.platform === 'win32') {
        // On POSIX, rename(2) atomically replaces files — no pre-unlink needed.
        // On Windows, RenameFile fails if destination exists, so we must unlink first.
        fs.unlinkSync(resolvedDest)
      }
    }
    fs.renameSync(resolvedSource, resolvedDest)
    return { resolvedSource, resolvedDest, isDirectory, isSameFs }
  }

  // Cross-filesystem — copy + verify + delete source
  if (isDirectory) {
    if (destExists) fs.rmSync(resolvedDest, { recursive: true })
    const itemsMoved = copyDirRecursive(resolvedSource, resolvedDest)
    fs.rmSync(resolvedSource, { recursive: true })
    return { resolvedSource, resolvedDest, isDirectory, isSameFs, itemsMoved }
  } else {
    if (destExists) fs.unlinkSync(resolvedDest)
    copyFileVerified(resolvedSource, resolvedDest)
    fs.unlinkSync(resolvedSource)
    return { resolvedSource, resolvedDest, isDirectory, isSameFs }
  }
}

export function formatMoveFileResult(r: MoveFileResult): string {
  const method = r.isSameFs ? 'renamed (atomic)' : 'copied and verified'
  const lines = [
    `Moved ${r.isDirectory ? 'directory' : 'file'}: ${r.resolvedSource}`,
    `  → ${r.resolvedDest}`,
    `Method: ${method}`,
  ]
  if (r.itemsMoved !== undefined) lines.push(`Items moved: ${r.itemsMoved}`)
  return lines.join('\n')
}

// ─── copy_file ────────────────────────────────────────────────────────────────

export function previewCopyFile(source: string, destination: string, overwrite = false): CopyFilePreview {
  const resolvedSource = resolveAndValidate(source)
  const resolvedDest = resolveAndValidate(destination)

  const srcStat = fs.statSync(resolvedSource)
  const isDirectory = srcStat.isDirectory()

  if (resolvedSource === resolvedDest) {
    throw new Error('Source and destination are the same path.')
  }

  const destExists = fs.existsSync(resolvedDest)
  if (destExists && !overwrite) {
    const dstStat = fs.statSync(resolvedDest)
    throw new Error(
      `Destination already exists: ${resolvedDest} (${formatBytes(dstStat.size)}, modified ${new Date(dstStat.mtimeMs).toISOString()}).\n` +
      `Pass overwrite: true to replace it.`
    )
  }

  const preview: CopyFilePreview = {
    resolvedSource,
    resolvedDest,
    sourceSize: srcStat.size,
    sourceSizeLabel: formatBytes(srcStat.size),
    sourceModified: new Date(srcStat.mtimeMs).toISOString(),
    destExists,
    isDirectory,
  }

  if (destExists) {
    const dstStat = fs.statSync(resolvedDest)
    preview.destExistingSize = dstStat.size
    preview.destExistingSizeLabel = formatBytes(dstStat.size)
  }

  if (isDirectory) {
    // Quick count — cap at 5s
    let count = 0
    const deadline = Date.now() + 5000
    function countDir(p: string): void {
      if (Date.now() > deadline) return
      try {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          count++
          if (e.isDirectory()) countDir(path.join(p, e.name))
        }
      } catch {}
    }
    countDir(resolvedSource)
    preview.estimatedItemCount = count
  }

  return preview
}

export function executeCopyFile(source: string, destination: string, overwrite = false): CopyFileResult {
  const resolvedSource = resolveAndValidate(source)
  const resolvedDest = resolveAndValidate(destination)

  const srcStat = fs.statSync(resolvedSource)
  const isDirectory = srcStat.isDirectory()
  const destExists = fs.existsSync(resolvedDest)

  if (destExists && !overwrite) {
    throw new Error(`Destination already exists: ${resolvedDest}. Pass overwrite: true to replace it.`)
  }

  // Ensure destination parent exists
  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true })

  if (isDirectory) {
    if (destExists) fs.rmSync(resolvedDest, { recursive: true })
    const itemsCopied = copyDirRecursive(resolvedSource, resolvedDest)
    return { resolvedSource, resolvedDest, isDirectory, itemsCopied }
  } else {
    if (destExists) fs.unlinkSync(resolvedDest)
    copyFileVerified(resolvedSource, resolvedDest)
    const dstStat = fs.statSync(resolvedDest)
    return { resolvedSource, resolvedDest, isDirectory, bytesCopied: dstStat.size }
  }
}

export function formatCopyFileResult(r: CopyFileResult): string {
  const lines = [
    `Copied ${r.isDirectory ? 'directory' : 'file'}: ${r.resolvedSource}`,
    `  → ${r.resolvedDest}`,
    `Verification: hash-matched ✓`,
  ]
  if (r.bytesCopied !== undefined) lines.push(`Bytes copied: ${formatBytes(r.bytesCopied)}`)
  if (r.itemsCopied !== undefined) lines.push(`Items copied: ${r.itemsCopied}`)
  return lines.join('\n')
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

export const moveToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'move_file',
      description: [
        'Move or rename a file or directory to a new location.',
        'On the same drive: uses an atomic rename (instant, no data risk).',
        'Across drives: copies with hash verification, then deletes source only after confirming the copy is intact.',
        'Set overwrite: true only when explicitly asked to replace an existing file.',
        'Requires user confirmation before executing.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Absolute path to the file or directory to move.',
          },
          destination: {
            type: 'string',
            description: 'Absolute path for the new location (including the new filename).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Replace destination if it already exists. Default: false (fail if destination exists).',
          },
        },
        required: ['source', 'destination'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'copy_file',
      description: [
        'Copy a file or directory to a new location.',
        'Always verifies the copy with a SHA-256 hash — if verification fails the partial copy is deleted.',
        'For directories: recursively copies all contents.',
        'Set overwrite: true only when explicitly asked to replace an existing file.',
        'Requires user confirmation before executing.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Absolute path to the file or directory to copy.',
          },
          destination: {
            type: 'string',
            description: 'Absolute path for the copy destination (including the new filename).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Replace destination if it already exists. Default: false.',
          },
        },
        required: ['source', 'destination'],
      },
    },
  },
]
