import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load phrase lists ────────────────────────────────────────────────────────

interface FrustrationPhrases {
  default_patterns: string[]
}

let _frustrationData: FrustrationPhrases | null = null

function getFrustrationData(): FrustrationPhrases {
  if (!_frustrationData) {
    const raw = readFileSync(join(__dirname, '../../data/frustration-phrases.json'), 'utf8')
    _frustrationData = JSON.parse(raw)
  }
  return _frustrationData!
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FrustrationResult {
  detected: boolean
  phrases: string[]
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function detectFrustration(
  normalizedText: string,
  priorTurnCount: number,
  knownPatterns: string[] = []
): FrustrationResult {
  // Frustration only makes sense in a back-and-forth — not on the first message
  if (priorTurnCount < 1) {
    return { detected: false, phrases: [] }
  }

  const frustrationData = getFrustrationData()

  // User-specific patterns take priority, defaults fill the rest
  // Both are deduplicated by Set below to avoid double-counting
  const allPatterns = [...new Set([...knownPatterns, ...frustrationData.default_patterns])]

  const foundPhrases: string[] = []

  for (const pattern of allPatterns) {
    if (normalizedText.includes(pattern.toLowerCase())) {
      foundPhrases.push(pattern)
    }
  }

  return {
    detected: foundPhrases.length > 0,
    phrases: foundPhrases,
  }
}
