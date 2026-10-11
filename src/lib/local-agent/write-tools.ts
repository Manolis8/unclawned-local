import fs from 'fs'
import path from 'path'
import { validatePath, formatBytes } from './security.js'

export type WriteMode = 'create' | 'overwrite' | 'append'

export interface WriteFileResult {
  resolvedPath: string
  bytesWritten: number
  mode: WriteMode
  existedBefore: boolean
}

export interface WriteFilePreview {
  resolvedPath: string
  mode: WriteMode
  existedBefore: boolean
  existingPreview: string | null  // first 10 lines of existing file (for overwrite warning)
  contentPreview: string          // first 20 lines of content to write
  contentLineCount: number
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────

type ExistingEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16-le' | 'utf-16-be' | 'unknown'

function detectExistingEncoding(filePath: string): ExistingEncoding {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4)
    const read = fs.readSync(fd, buf, 0, 4, 0)
    fs.closeSync(fd)
    if (read >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf-8-bom'
    if (read >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf-16-le'
    if (read >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf-16-be'
    return 'utf-8'
  } catch {
    return 'unknown'
  }
}

function encodeContent(content: string, encoding: ExistingEncoding): Buffer {
  if (encoding === 'utf-8-bom') {
    return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(content, 'utf-8')])
  }
  if (encoding === 'utf-16-le') {
    return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(content, 'utf16le')])
  }
  if (encoding === 'utf-16-be') {
    // Node has no native utf-16-be encoder — encode as LE then swap byte pairs
    const le = Buffer.from(content, 'utf16le')
    for (let i = 0; i < le.length - 1; i += 2) {
      const tmp = le[i]; le[i] = le[i + 1]; le[i + 1] = tmp
    }
    return Buffer.concat([Buffer.from([0xFE, 0xFF]), le])
  }
  // Default: UTF-8 without BOM
  return Buffer.from(content, 'utf-8')
}

// ─── Atomic write ─────────────────────────────────────────────────────────────

async function renameWithRetry(src: string, dst: string, retries = 3): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      fs.renameSync(src, dst)
      return
    } catch (err: any) {
      if (attempt === retries - 1) {
        throw new Error(
          `Could not write file — it may be open in another application.\n` +
          `Close the file and try again. (${err.message})`
        )
      }
      await new Promise(r => setTimeout(r, 300))
    }
  }
}

async function atomicWrite(resolvedPath: string, content: string, encoding: ExistingEncoding): Promise<void> {
  const dir = path.dirname(resolvedPath)
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const tmpPath = path.join(dir, `.openclaw-tmp-${suffix}`)
  const buf = encodeContent(content, encoding)
  try {
    fs.writeFileSync(tmpPath, buf)
    const stat = fs.statSync(tmpPath)
    if (stat.size !== buf.length) {
      throw new Error(`Write verification failed (expected ${buf.length} bytes, got ${stat.size}).`)
    }
    await renameWithRetry(tmpPath, resolvedPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch {}
    throw err
  }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export function previewWriteFile(
  filePath: string,
  content: string,
  mode: WriteMode = 'create'
): WriteFilePreview {
  const resolved = validatePath(filePath)
  const existedBefore = fs.existsSync(resolved)

  let existingPreview: string | null = null
  if (existedBefore && mode === 'overwrite') {
    try {
      const existing = fs.readFileSync(resolved, 'utf-8')
      const lines = existing.split('\n').slice(0, 10)
      existingPreview = lines.join('\n') + (existing.split('\n').length > 10 ? '\n...' : '')
    } catch {
      existingPreview = '(could not read existing file)'
    }
  }

  const contentLines = content.split('\n')
  const contentPreview = contentLines.slice(0, 20).join('\n') +
    (contentLines.length > 20 ? `\n... (${contentLines.length - 20} more lines)` : '')

  return {
    resolvedPath: resolved,
    mode,
    existedBefore,
    existingPreview,
    contentPreview,
    contentLineCount: contentLines.length,
  }
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export async function executeWriteFile(
  preview: WriteFilePreview,
  content: string
): Promise<WriteFileResult> {
  const { resolvedPath: resolved, mode, existedBefore } = preview

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(resolved), { recursive: true })

  if (mode === 'create' && existedBefore) {
    throw new Error(
      `File already exists: "${resolved}". Use mode "overwrite" to replace it or "append" to add to it.`
    )
  }

  if (mode === 'append') {
    // If the file exists and doesn't end with a newline, add one so the
    // appended content starts on its own line rather than merging with the last.
    let contentToAppend = content
    if (existedBefore) {
      const size = fs.statSync(resolved).size
      if (size > 0) {
        const tail = Buffer.alloc(1)
        const fd = fs.openSync(resolved, 'r')
        fs.readSync(fd, tail, 0, 1, size - 1)
        fs.closeSync(fd)
        if (tail[0] !== 0x0a) contentToAppend = '\n' + content
      }
    }
    fs.appendFileSync(resolved, contentToAppend, 'utf-8')
  } else {
    // create or overwrite — use atomic temp-file-then-rename
    const encoding: ExistingEncoding = (mode === 'overwrite' && existedBefore)
      ? detectExistingEncoding(resolved)
      : 'utf-8'
    await atomicWrite(resolved, content, encoding === 'unknown' ? 'utf-8' : encoding)
  }

  return {
    resolvedPath: resolved,
    bytesWritten: Buffer.byteLength(content, 'utf-8'),
    mode,
    existedBefore,
  }
}

export function formatWriteFileResult(r: WriteFileResult): string {
  const action = r.mode === 'append' ? 'Appended to' : r.existedBefore ? 'Overwrote' : 'Created'
  return `${action}: ${r.resolvedPath} (${formatBytes(r.bytesWritten)})`
}

// ─── create_directory ─────────────────────────────────────────────────────────

export interface CreateDirectoryResult {
  resolvedPath: string
  alreadyExisted: boolean
}

export function executeCreateDirectory(dirPath: string): CreateDirectoryResult {
  const resolved = validatePath(dirPath)
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Path exists but is a file, not a directory: ${resolved}`)
    }
    return { resolvedPath: resolved, alreadyExisted: true }
  }
  fs.mkdirSync(resolved, { recursive: true })
  return { resolvedPath: resolved, alreadyExisted: false }
}

export function formatCreateDirectoryResult(r: CreateDirectoryResult): string {
  return r.alreadyExisted
    ? `Directory already exists: ${r.resolvedPath}`
    : `Created directory: ${r.resolvedPath}`
}

export const writeToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'create_directory',
      description: [
        'Create a new directory (folder) on the user\'s computer.',
        'Automatically creates all missing intermediate parent directories.',
        'Safe to call even if the directory already exists — reports the path without error.',
        'This is a T0 (auto) operation — no confirmation needed since it is non-destructive.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path of the directory to create.',
          },
        },
        required: ['path'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: [
        'Write content to a file on the user\'s local computer.',
        'ALWAYS call confirm_action before writing — this tool triggers the approval flow automatically.',
        'Use create mode for new files, overwrite to replace, append to add to the end.',
        'The user will see a preview of exactly what will be written before it happens.',
        'Writes use atomic temp-file-then-rename — the file is never left half-written.',
        'Overwrite preserves the existing file\'s encoding (UTF-8, UTF-16, etc.).',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path where the file will be written. Use the full path including filename and extension.',
          },
          content: {
            type: 'string',
            description: 'The full text content to write to the file.',
          },
          mode: {
            type: 'string',
            enum: ['create', 'overwrite', 'append'],
            description: 'create = new file (fails if exists), overwrite = replace existing, append = add to end. Default: create.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
]
