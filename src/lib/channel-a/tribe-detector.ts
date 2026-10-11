import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load dictionary ─────────────────────────────────────────────────────────

interface TribeDictionary {
  tribes: Record<string, { terms: string[] }>
}

let _tribesData: TribeDictionary | null = null

function getTribesData(): TribeDictionary {
  if (!_tribesData) {
    const raw = readFileSync(join(__dirname, '../../data/vocabulary-tribes.json'), 'utf8')
    _tribesData = JSON.parse(raw)
  }
  return _tribesData!
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TribeHits {
  [tribe: string]: string[]
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function detectVocabularyTribeHits(
  normalizedText: string,
  words: string[],
  userOwnedText: string,
  containsPastedContent: boolean
): TribeHits {
  const tribesData = getTribesData()

  // If pasted content detected, run tribe detection only on the user's own words
  // to avoid contamination from pasted documents
  // When pasted content is detected, restrict tribe detection to the user's own words
  // only. Using the full normalizedText or the full words array would contaminate tribe
  // scores with vocabulary from pasted documents (e.g. a McKinsey report pasted as context).
  const textToSearch = containsPastedContent
    ? userOwnedText.toLowerCase()
    : normalizedText

  // Build the word set from the SAME source as textToSearch — never the full words array
  // when pasted content is present. This is the key contamination guard.
  const searchWords = new Set(textToSearch.split(/\s+/).filter(w => w.length > 0))
  const hits: TribeHits = {}

  for (const [tribe, { terms }] of Object.entries(tribesData.tribes)) {
    const tribeHits: string[] = []

    for (const term of terms) {
      const termLower = term.toLowerCase()

      if (termLower.includes(' ')) {
        // Multi-word term: substring match in the relevant text
        if (textToSearch.includes(termLower)) {
          tribeHits.push(term)
        }
      } else {
        // Single word: exact match from words derived from the same source
        if (searchWords.has(termLower)) {
          tribeHits.push(term)
        }
      }
    }

    if (tribeHits.length > 0) {
      hits[tribe] = tribeHits
    }
  }

  return hits
}
