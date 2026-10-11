import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type DomainCategory =
  | 'productivity'
  | 'communication'
  | 'dev'
  | 'design'
  | 'data'
  | 'content'
  | 'finance'
  | 'research'
  | 'ai_tools'
  | 'other'

// ─── Load domain dictionary ───────────────────────────────────────────────────

let _domainMap: Map<string, DomainCategory> | null = null

function getDomainMap(): Map<string, DomainCategory> {
  if (_domainMap) return _domainMap

  const raw = readFileSync(join(__dirname, '../../data/domain-categories.json'), 'utf8')
  const data: Record<string, string[]> = JSON.parse(raw)

  _domainMap = new Map()
  for (const [category, domains] of Object.entries(data)) {
    for (const domain of domains) {
      _domainMap.set(domain.toLowerCase(), category as DomainCategory)
    }
  }
  return _domainMap
}

// ─── extractDomain ────────────────────────────────────────────────────────────
//
// Strips protocol, path, query, and subdomain variants to extract the
// canonical domain used as the lookup key.
//
// "https://app.notion.so/workspace/abc?q=1" → "notion.so"
// "https://mail.google.com/mail/u/0/"       → "mail.google.com"
// "https://github.com/user/repo"            → "github.com"

export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()

    // Strip "www." prefix but keep meaningful subdomains (app., mail., etc.)
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname
  } catch {
    // Not a valid URL — try stripping protocol manually
    const stripped = url.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0]
    return stripped.toLowerCase().replace(/^www\./, '')
  }
}

// ─── classifyDomain ───────────────────────────────────────────────────────────
//
// Looks up the domain in the category map.
// Falls back to checking if the hostname ends with a known domain
// (handles app.notion.so → try notion.so after failing app.notion.so).

export function classifyDomain(domain: string): DomainCategory {
  const map = getDomainMap()
  const lower = domain.toLowerCase()

  // Exact match first
  const exact = map.get(lower)
  if (exact) return exact

  // Try progressively stripping subdomains
  const parts = lower.split('.')
  for (let i = 1; i < parts.length - 1; i++) {
    const shorter = parts.slice(i).join('.')
    const match = map.get(shorter)
    if (match) return match
  }

  return 'other'
}
