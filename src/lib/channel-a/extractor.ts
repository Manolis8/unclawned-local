import { normalizeMessage } from './normalizer.js'
import { classifyTaskType } from './task-classifier.js'
import { detectVocabularyTribeHits } from './tribe-detector.js'
import { detectHedging } from './hedging-detector.js'
import { detectFrustration } from './frustration-detector.js'
import { insertRawSignal, updateWordFrequency } from './signal-inserter.js'
import { updateChannelAProfile, getKnownFrustrationPatterns } from './profile-builder.js'

// ─── Main extraction entry point ──────────────────────────────────────────────
//
// Called fire-and-forget after every user message. Never throws — failures are
// caught and logged so they can never affect the response path.
//
// priorTurnCount: how many prior messages exist in this conversation.
//   - Chat sessions: historyRows.length
//   - Fresh task submissions: 0

export async function extractChannelASignals(
  userId: string,
  messageText: string,
  taskId: string | null = null,
  priorTurnCount: number = 0
): Promise<void> {
  try {
    // Step 1: Load user-specific frustration patterns from current profile
    const knownFrustrationPatterns = getKnownFrustrationPatterns(userId)

    // Step 2: Normalize — strip/lowercase/tokenize
    const norm = normalizeMessage(messageText)

    // Step 3: Classify task type from opening words
    const taskType = classifyTaskType(messageText)

    // Step 4: Vocabulary tribe hits
    const tribeWordHits = detectVocabularyTribeHits(
      norm.normalizedText,
      norm.words,
      norm.userOwnedText,
      norm.containsPastedContent
    )

    // Step 5: Hedging detection (first third of message only)
    const hedging = detectHedging(norm.firstThird)

    // Step 6: Frustration detection (skipped if priorTurnCount === 0)
    const frustration = detectFrustration(
      norm.normalizedText,
      priorTurnCount,
      knownFrustrationPatterns
    )

    // Step 7: Write raw signal row
    insertRawSignal({
      userId,
      taskId,
      messageText,
      messageLength: norm.charCount,
      wordCount: norm.wordCount,
      taskType,
      priorTurnCount,
      containsPastedContent: norm.containsPastedContent,
      tribeWordHits,
      hedgingDetected: hedging.detected,
      hedgingPhrases: hedging.phrases,
      frustrationDetected: frustration.detected,
      frustrationPhrases: frustration.phrases,
    })

    // Step 8: Update word frequency table
    updateWordFrequency(userId, tribeWordHits)

    // Step 9: Rebuild compiled profile (incremental update)
    updateChannelAProfile(userId, {
      taskType,
      messageLength: norm.charCount,
      hedgingDetected: hedging.detected,
      frustrationDetected: frustration.detected,
      frustrationPhrases: frustration.phrases,
    })

    console.log(
      `[channel-a] extracted | type=${taskType}` +
      ` tribes=[${Object.keys(tribeWordHits).join(',')}]` +
      ` hedging=${hedging.detected}` +
      ` frustration=${frustration.detected}` +
      ` samples+1`
    )

    // Step 10: Channel D — D.3 new domain debut detection
    const debutCandidates = Object.entries(tribeWordHits).filter(([, words]) => words.length >= 2)
    if (debutCandidates.length > 0) {
      const { checkNewDomainTrigger } = await import('../channel-d/trigger-detector.js')
      for (const [tribeKey, tribeWords] of debutCandidates) {
        checkNewDomainTrigger(userId, null, tribeKey, tribeWords.length)
      }
    }

  } catch (err) {
    console.error('[channel-a] Extraction pipeline failed:', err)

    // Best-effort fallback: insert an error row so we know extraction ran
    // but failed, rather than silently dropping the event
    try {
      insertRawSignal({
        userId,
        taskId,
        messageText: messageText.slice(0, 200),
        messageLength: messageText.length,
        wordCount: messageText.trim().split(/\s+/).filter(Boolean).length,
        taskType: 'unknown',
        priorTurnCount,
        containsPastedContent: false,
        tribeWordHits: {},
        hedgingDetected: false,
        hedgingPhrases: [],
        frustrationDetected: false,
        frustrationPhrases: [],
        extractionError: String(err).slice(0, 500),
      })
    } catch {
      // Absolute fallback — don't propagate
    }
  }
}
