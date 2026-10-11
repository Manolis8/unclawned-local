import fs from 'fs'
import path from 'path'
import os from 'os'
import { validatePath } from './security.js'
import { markLastDeleteRolledBack } from './session-journal.js'

// ─── Session recycle bin ──────────────────────────────────────────────────────
// Each session gets its own subdirectory under {tmpdir}/openclaw-recycle/{sessionId}/
// Files are renamed there instead of deleted — fully recoverable within the session.

const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const RECYCLE_BASE = path.join(os.tmpdir(), 'openclaw-recycle', SESSION_ID)

let _recycleDirReady = false
function ensureRecycleDir(): void {
  if (_recycleDirReady) return
  fs.mkdirSync(RECYCLE_BASE, { recursive: true })
  _recycleDirReady = true
}

// ─── Delete journal ───────────────────────────────────────────────────────────
// In-memory ordered log so restore_last_delete can pop the most recent entry.

interface DeleteJournalEntry {
  originalPath: string
  recyclePath: string
  type: 'file' | 'directory'
  deletedAt: number
}

const deleteJournal: DeleteJournalEntry[] = []

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface DeleteFileResult {
  originalPath: string
  recyclePath: string
  type: 'file'
  sizeBytes: number
}

export interface DeleteDirectoryResult {
  originalPath: string
  recyclePath: string
  type: 'directory'
  itemCount: number
}

export interface RestoreResult {
  restoredPath: string
  fromRecyclePath: string
  type: 'file' | 'directory'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveAndValidate(filePath: string): string {
  const expanded = filePath.startsWith('~')
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath
  const resolved = path.resolve(expanded)
  validatePath(resolved)  // throws if outside allowed dirs
  return resolved
}

function uniqueRecyclePath(originalPath: string): string {
  ensureRecycleDir()
  const base = path.basename(originalPath)
  const ts = Date.now()
  // Append timestamp to avoid collision when the same name is deleted twice
  return path.join(RECYCLE_BASE, `${ts}_${base}`)
}

function countItems(dirPath: string): number {
  let count = 0
  function walk(p: string): void {
    try {
      const entries = fs.readdirSync(p, { withFileTypes: true })
      count += entries.length
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(p, e.name))
      }
    } catch {}
  }
  walk(dirPath)
  return count
}

function copyDirToDst(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDirToDst(s, d)
    else fs.copyFileSync(s, d)
  }
}

// Rename with cross-filesystem fallback (EXDEV = source and dest on different drives)
function safeMove(src: string, dst: string, isDir: boolean): void {
  try {
    fs.renameSync(src, dst)
  } catch (err: any) {
    if (err.code !== 'EXDEV') throw err
    // Cross-filesystem: copy then delete source
    if (isDir) {
      copyDirToDst(src, dst)
      fs.rmSync(src, { recursive: true })
    } else {
      fs.copyFileSync(src, dst)
      fs.unlinkSync(src)
    }
  }
}

// ─── Preview functions (resolve + stat without mutating anything) ─────────────

export interface DeleteFilePreview {
  resolvedPath: string
  sizeBytes: number
  sizeLabel: string
}

export interface DeleteDirectoryPreview {
  resolvedPath: string
  itemCount: number
}

export function previewDeleteFile(filePath: string): DeleteFilePreview {
  const resolved = resolveAndValidate(filePath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`Path is not a file: ${resolved}`)
  const kb = (stat.size / 1024).toFixed(1)
  return { resolvedPath: resolved, sizeBytes: stat.size, sizeLabel: `${kb} KB` }
}

export function previewDeleteDirectory(dirPath: string): DeleteDirectoryPreview {
  const resolved = resolveAndValidate(dirPath)
  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`)
  return { resolvedPath: resolved, itemCount: countItems(resolved) }
}

// ─── delete_file ──────────────────────────────────────────────────────────────

export function deleteFile(filePath: string): DeleteFileResult {
  const resolved = resolveAndValidate(filePath)

  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`Path is not a file: ${resolved}`)

  const recyclePath = uniqueRecyclePath(resolved)
  safeMove(resolved, recyclePath, false)

  const entry: DeleteJournalEntry = {
    originalPath: resolved,
    recyclePath,
    type: 'file',
    deletedAt: Date.now(),
  }
  deleteJournal.push(entry)

  return { originalPath: resolved, recyclePath, type: 'file', sizeBytes: stat.size }
}

export function formatDeleteFileResult(r: DeleteFileResult): string {
  const kb = (r.sizeBytes / 1024).toFixed(1)
  return [
    `Deleted file: ${r.originalPath}`,
    `Size: ${kb} KB`,
    `Moved to recycle bin (this session). Call restore_last_delete to undo.`,
  ].join('\n')
}

// ─── delete_directory ─────────────────────────────────────────────────────────

export function deleteDirectory(dirPath: string): DeleteDirectoryResult {
  const resolved = resolveAndValidate(dirPath)

  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`)

  const itemCount = countItems(resolved)
  const recyclePath = uniqueRecyclePath(resolved)

  safeMove(resolved, recyclePath, true)

  const entry: DeleteJournalEntry = {
    originalPath: resolved,
    recyclePath,
    type: 'directory',
    deletedAt: Date.now(),
  }
  deleteJournal.push(entry)

  return { originalPath: resolved, recyclePath, type: 'directory', itemCount }
}

export function formatDeleteDirectoryResult(r: DeleteDirectoryResult): string {
  return [
    `Deleted directory: ${r.originalPath}`,
    `Contents: ${r.itemCount} item(s)`,
    `Moved to recycle bin (this session). Call restore_last_delete to undo.`,
  ].join('\n')
}

// ─── restore_last_delete ──────────────────────────────────────────────────────

export function restoreLastDelete(): RestoreResult {
  if (deleteJournal.length === 0) {
    throw new Error('Nothing to restore — delete journal is empty for this session.')
  }

  const entry = deleteJournal[deleteJournal.length - 1]

  // Check the recycle path still exists (user may have cleared tmpdir manually)
  if (!fs.existsSync(entry.recyclePath)) {
    deleteJournal.pop()
    throw new Error(`Recycle bin entry no longer exists: ${entry.recyclePath}`)
  }

  // If the original path now exists (user created something with the same name), refuse
  if (fs.existsSync(entry.originalPath)) {
    throw new Error(
      `Cannot restore — a file or directory already exists at the original location: ${entry.originalPath}`
    )
  }

  // Ensure the parent directory exists (it may have been deleted too)
  fs.mkdirSync(path.dirname(entry.originalPath), { recursive: true })

  safeMove(entry.recyclePath, entry.originalPath, entry.type === 'directory')
  deleteJournal.pop()

  // Tell the session journal that this delete was already undone so undo_last_change
  // skips it and goes to the operation before the delete (e.g. an edit).
  markLastDeleteRolledBack(entry.originalPath)

  return {
    restoredPath: entry.originalPath,
    fromRecyclePath: entry.recyclePath,
    type: entry.type,
  }
}

export function formatRestoreResult(r: RestoreResult): string {
  return [
    `Restored ${r.type}: ${r.restoredPath}`,
    `(Removed from recycle bin)`,
  ].join('\n')
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

export const deleteToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'delete_file',
      description: [
        'Delete a file from the user\'s computer.',
        'The file is moved to a session recycle bin — it is NOT permanently deleted.',
        'Call restore_last_delete immediately to undo if something went wrong.',
        'Requires user confirmation before executing.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to delete.',
          },
        },
        required: ['path'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'delete_directory',
      description: [
        'Delete a directory and all its contents from the user\'s computer.',
        'The directory is moved to a session recycle bin — it is NOT permanently deleted.',
        'Call restore_last_delete immediately to undo if something went wrong.',
        'Requires user confirmation before executing.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory to delete.',
          },
        },
        required: ['path'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'restore_last_delete',
      description: [
        'Undo the last delete_file or delete_directory operation in this session.',
        'Restores the file or directory to its original location.',
        'Only works within the current session — recycle bin is cleared when the server restarts.',
        'Fails if something already exists at the original path.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
]
