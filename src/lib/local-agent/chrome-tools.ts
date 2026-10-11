import fs from 'fs'
import path from 'path'
import os from 'os'
import { DatabaseSync } from 'node:sqlite'

// ─── Chrome profile directory ─────────────────────────────────────────────────

function getChromeProfileDir(): string {
  const base = process.env.LOCALAPPDATA
    ?? path.join(os.homedir(), 'AppData', 'Local')
  // Check profiles in order of likelihood
  const candidates = [
    path.join(base, 'Google', 'Chrome', 'User Data', 'Default'),
    path.join(base, 'Google', 'Chrome Beta', 'User Data', 'Default'),
    path.join(base, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default'),
    path.join(base, 'Microsoft', 'Edge', 'User Data', 'Default'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  throw new Error('Chrome profile directory not found. Is Chrome (or Brave/Edge) installed?')
}

// ─── Bookmarks ────────────────────────────────────────────────────────────────

export interface Bookmark {
  title: string
  url: string
  folder: string
  dateAdded: string
}

function flattenBookmarks(node: any, folderPath: string, out: Bookmark[]) {
  if (node.type === 'url') {
    const ms = Math.round(parseInt(node.date_added || '0') / 1000)
    const date = ms > 0 ? new Date(ms).toISOString().split('T')[0] : ''
    out.push({ title: node.name || '', url: node.url || '', folder: folderPath, dateAdded: date })
  } else if (node.type === 'folder' && Array.isArray(node.children)) {
    const next = folderPath ? `${folderPath} / ${node.name}` : node.name
    for (const child of node.children) flattenBookmarks(child, next, out)
  }
}

export function getChromeBookmarks(searchTerm?: string): { bookmarks: Bookmark[]; total: number } {
  const bookmarksFile = path.join(getChromeProfileDir(), 'Bookmarks')
  if (!fs.existsSync(bookmarksFile)) {
    throw new Error('Chrome Bookmarks file not found.')
  }
  const raw = JSON.parse(fs.readFileSync(bookmarksFile, 'utf-8'))
  const roots = raw.roots || {}
  const all: Bookmark[] = []
  for (const root of Object.values(roots) as any[]) {
    flattenBookmarks(root, '', all)
  }
  if (!searchTerm) return { bookmarks: all, total: all.length }
  const q = searchTerm.toLowerCase()
  const filtered = all.filter(b =>
    b.title.toLowerCase().includes(q) ||
    b.url.toLowerCase().includes(q) ||
    b.folder.toLowerCase().includes(q)
  )
  return { bookmarks: filtered, total: all.length }
}

export function formatBookmarks(result: { bookmarks: Bookmark[]; total: number }, searchTerm?: string): string {
  const { bookmarks, total } = result
  if (bookmarks.length === 0) return searchTerm
    ? `No bookmarks found matching "${searchTerm}" (${total} total).`
    : 'No bookmarks saved.'
  const header = searchTerm
    ? `Found ${bookmarks.length} bookmark(s) matching "${searchTerm}" (${total} total):\n`
    : `${total} bookmark(s):\n`
  return header + bookmarks.map(b => {
    const folder = b.folder ? `[${b.folder}] ` : ''
    return `${folder}${b.title}\n  ${b.url}${b.dateAdded ? '  (saved ' + b.dateAdded + ')' : ''}`
  }).join('\n\n')
}

// ─── History ──────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisit: string
}

export function getChromeHistory(opts: {
  limit?: number
  search?: string
  daysBack?: number
}): HistoryEntry[] {
  const historyFile = path.join(getChromeProfileDir(), 'History')
  if (!fs.existsSync(historyFile)) {
    throw new Error('Chrome History file not found.')
  }
  // Copy to temp to avoid SQLite lock (Chrome keeps the file open)
  const tmp = path.join(os.tmpdir(), `openclaw-chrome-history-${Date.now()}.db`)
  try {
    fs.copyFileSync(historyFile, tmp)
    const db: any = new DatabaseSync(tmp, { readOnly: true })

    const limit = opts.limit ?? 100
    const daysBack = opts.daysBack ?? 30
    // Chrome stores timestamps as microseconds since Jan 1, 1601
    const CHROME_EPOCH_OFFSET = 11644473600000000n
    const cutoff = BigInt(Date.now()) * 1000n - CHROME_EPOCH_OFFSET - BigInt(daysBack) * 86400n * 1000000n

    let query = `
      SELECT u.url, u.title, u.visit_count,
             MAX(v.visit_time) as last_visit_time
      FROM urls u
      JOIN visits v ON v.url = u.id
      WHERE v.visit_time > ?
    `
    const params: any[] = [cutoff.toString()]
    if (opts.search) {
      query += ` AND (u.url LIKE ? OR u.title LIKE ?)`
      params.push(`%${opts.search}%`, `%${opts.search}%`)
    }
    query += ` GROUP BY u.id ORDER BY last_visit_time DESC LIMIT ?`
    params.push(limit)

    const rows = db.prepare(query).all(...params) as any[]
    db.close()

    return rows.map(r => {
      const microsSince1601 = BigInt(r.last_visit_time)
      const ms = Number((microsSince1601 + CHROME_EPOCH_OFFSET) / 1000n)
      const lastVisit = new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
      return {
        url: r.url,
        title: r.title || '(no title)',
        visitCount: r.visit_count,
        lastVisit,
      }
    })
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

export function formatHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) return 'No history entries found.'
  return entries.map(e =>
    `${e.lastVisit}  (${e.visitCount}x)  ${e.title}\n  ${e.url}`
  ).join('\n\n')
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const chromeToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'get_chrome_cookies',
      description: [
        'Read cookies from the currently connected Chrome browser via CDP.',
        'Requires the browser to be attached (works during browser tasks or after navigate).',
        'Returns cookie name, value, and domain. Optionally filter by domain.',
        'Use when the user asks to check login state, session tokens, or site cookies.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Optional domain filter (e.g. "google.com"). Returns only cookies whose domain contains this string.',
          },
          limit: {
            type: 'number',
            description: 'Max cookies to return (default 100, max 500).',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_chrome_bookmarks',
      description: [
        'Read the user\'s Chrome bookmarks from disk.',
        'Returns all saved bookmarks with title, URL, folder path, and date added.',
        'Optionally filter by a search term matched against title, URL, or folder name.',
        'Use this when the user asks to find a bookmarked site, check what they\'ve saved, or search their bookmarks.',
        'Works even when Chrome is closed. Reads the live Bookmarks file directly.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Optional search term to filter bookmarks by title, URL, or folder.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_chrome_history',
      description: [
        'Read the user\'s Chrome browsing history.',
        'Returns recent visited URLs with title, visit count, and last visit timestamp.',
        'Use this when the user asks to find a previously visited site, look up what they browsed, or search history.',
        'Can filter by search term and limit to recent days.',
        'Makes a safe temp-file copy of the History database — Chrome stays open normally.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Optional search term to filter by URL or page title.',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 50, max 200).',
          },
          days_back: {
            type: 'number',
            description: 'How many days back to search (default 30).',
          },
        },
        required: [],
      },
    },
  },
]
