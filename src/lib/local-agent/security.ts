import { homedir } from 'os'
import path from 'path'
import { resolveSpecialFolderAlias } from './special-folders.js'

// System directories that are never accessible, regardless of any config
const BLOCKED_PATH_PATTERNS: RegExp[] = [
  // Windows system dirs
  /^[A-Za-z]:[/\\]Windows([/\\]|$)/i,
  /^[A-Za-z]:[/\\]Program Files([/\\]|$)/i,
  /^[A-Za-z]:[/\\]Program Files \(x86\)([/\\]|$)/i,
  /^[A-Za-z]:[/\\]ProgramData([/\\]|$)/i,
  /^[A-Za-z]:[/\\]System32([/\\]|$)/i,
  /^[A-Za-z]:[/\\]\$Recycle\.Bin([/\\]|$)/i,
  // Unix system dirs
  /^\/etc([/]|$)/,
  /^\/sys([/]|$)/,
  /^\/proc([/]|$)/,
  /^\/dev([/]|$)/,
  /^\/boot([/]|$)/,
  /^\/bin([/]|$)/,
  /^\/sbin([/]|$)/,
  /^\/lib([/]|$)/,
  /^\/usr\/bin([/]|$)/,
  /^\/usr\/sbin([/]|$)/,
]

// File extensions that cannot be read as text
const BINARY_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.raw',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.m4a',
  '.exe', '.dll', '.sys', '.bin', '.so', '.dylib', '.a', '.o',
  '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z', '.xz',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods',  // these are zip archives
  '.sqlite', '.db',  // binary DBs (handle separately if needed)
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pyc', '.pyo', '.class',
])

// Patterns that should never appear in path arguments (injection prevention)
const SHELL_METACHAR_RE = /[;&|`$(){}[\]<>!]/g

export function getAllowedDirs(): string[] {
  return [homedir()]
}

export function validatePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path must be a non-empty string.')
  }

  // Strip shell metacharacters — these have no place in a file path
  const sanitized = inputPath.replace(SHELL_METACHAR_RE, '').trim()

  // Resolve to absolute path (handles ~, .., relative paths)
  // Then apply OS special-folder aliases (e.g. ~/Desktop → ~/OneDrive/Desktop on
  // Windows machines with OneDrive Desktop redirection). This is the same resolution
  // that Windows Explorer uses, so files land in the folder the user actually sees.
  const resolved = resolveSpecialFolderAlias(
    path.resolve(sanitized.replace(/^~/, homedir()))
  )

  // Block traversal tricks that survived resolve (shouldn't happen but belt+suspenders)
  if (resolved.includes('..')) {
    throw new Error('Path traversal detected. Use absolute paths.')
  }

  // Block system directories
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      throw new Error(
        `Access denied: "${resolved}" is a protected system directory. ` +
        `The agent can only access files under your home directory (${homedir()}).`
      )
    }
  }

  // Enforce allowed directories
  const allowed = getAllowedDirs()
  const isAllowed = allowed.some(dir => {
    const normalDir = path.normalize(dir)
    const normalResolved = path.normalize(resolved)
    return normalResolved === normalDir || normalResolved.startsWith(normalDir + path.sep)
  })

  if (!isAllowed) {
    throw new Error(
      `Access denied: "${resolved}" is outside your home directory. ` +
      `Allowed root: ${homedir()}`
    )
  }

  return resolved
}

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
