import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load phrase lists ────────────────────────────────────────────────────────

interface HedgingPhrases {
  strong_hedges: string[]
  soft_hedges: string[]
}

let _hedgingData: HedgingPhrases | null = null

function getHedgingData(): HedgingPhrases {
  if (!_hedgingData) {
    const raw = readFileSync(join(__dirname, '../../data/hedging-phrases.json'), 'utf8')
    _hedgingData = JSON.parse(raw)
  }
  return _hedgingData!
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HedgingResult {
  detected: boolean
  phrases: string[]
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function detectHedging(firstThird: string): HedgingResult {
  // firstThird is already lowercased (from normalizer)
  const hedgingData = getHedgingData()
  const foundPhrases: string[] = []

  // One strong hedge is enough
  for (const phrase of hedgingData.strong_hedges) {
    if (firstThird.includes(phrase)) {
      foundPhrases.push(phrase)
    }
  }

  if (foundPhrases.length > 0) {
    return { detected: true, phrases: foundPhrases }
  }

  // Soft hedges need 2+ to count
  for (const phrase of hedgingData.soft_hedges) {
    if (firstThird.includes(phrase)) {
      foundPhrases.push(phrase)
    }
  }

  return {
    detected: foundPhrases.length >= 2,
    phrases: foundPhrases,
  }
}
