import { normalizeMessage } from '../channel-a/normalizer.js'
import { classifyTaskType } from '../channel-a/task-classifier.js'
import { computeLatencySeconds, bucketLatency, isLatencyMeaningful, detectRubberStamp } from './latency-calculator.js'
import { classifyPaste, extractPastedPortion, getPastedTribeHits } from './paste-classifier.js'
import { detectContinuation, detectCorrection, classifyCorrectionLevel } from './correction-detector.js'
import { insertRawSignal, insertPasteLog, mergeCorrection } from './signal-inserter.js'
import { updateChannelBProfile, upgradeCorrectionLevel } from './profile-builder.js'

// ─── Main extraction function ─────────────────────────────────────────────────
//
// Called fire-and-forget from the /chat route every time a user message arrives
// AFTER the prior message was from the assistant. Looks backwards at the prior
// response to extract reaction signals (latency, correction, paste type).
//
// priorUserMessage is the user's message that the agent was responding to —
// used to classify the prior task type. Pass null if not available.

export async function extractChannelBSignals(
  userId: string,
  currentMessage: string,
  priorAssistantMessage: string,
  priorAssistantCreatedAt: string,
  priorUserMessage: string | null,
  sessionId: string
): Promise<void> {
  const currentTime = new Date()

  // 1. Latency
  const latencySeconds = computeLatencySeconds(priorAssistantCreatedAt, currentTime)
  const latencyBucket = latencySeconds >= 0 ? bucketLatency(latencySeconds) : null
  const meaningfulLatency = latencyBucket ? isLatencyMeaningful(latencyBucket) : false
  const latencyForSignal = meaningfulLatency ? latencySeconds : null

  // 2. Prior task type (classify from the message the agent was responding to)
  const priorTaskType = priorUserMessage ? classifyTaskType(priorUserMessage) : null

  // 3. Normalize current message for paste detection
  const norm = normalizeMessage(currentMessage)

  // 4. Paste signals
  let pasteType: string | null = null
  let pasteCharCount: number | null = null
  let pasteTribeHits: Record<string, string[]> = {}
  let primaryTribe: string | null = null

  if (norm.containsPastedContent) {
    pasteType = classifyPaste(currentMessage)
    pasteCharCount = Math.max(0, currentMessage.length - norm.userOwnedText.length)
    const pastedPortion = extractPastedPortion(currentMessage, norm.userOwnedText)
    const tribeResult = getPastedTribeHits(pastedPortion)
    pasteTribeHits = tribeResult.hits
    primaryTribe = tribeResult.primaryTribe
  }

  // 5. Correction signals
  const isContinuation = detectContinuation(currentMessage, priorAssistantMessage)
  let isCorrection = false
  let correctionLevel: number | null = null
  let correctionPhrases: string[] = []

  if (isContinuation) {
    const corrResult = detectCorrection(currentMessage)
    isCorrection = corrResult.isCorrection
    correctionPhrases = corrResult.phrases
    if (isCorrection) {
      correctionLevel = classifyCorrectionLevel(
        currentMessage,
        priorTaskType,
        priorAssistantMessage.length
      )
    }
  }

  // 6. Rubber stamp
  const isRubberStamp = detectRubberStamp(
    latencySeconds,
    priorAssistantMessage.length,
    isCorrection
  )

  // 7. Multi-turn correction merge — don't insert a new row, update existing
  if (isCorrection && sessionId && correctionLevel !== null) {
    const mergeResult = mergeCorrection(sessionId, correctionLevel, correctionPhrases)
    if (mergeResult.merged) {
      // If the level was upgraded, correct the profile's level distribution
      if (mergeResult.oldLevel !== null && priorTaskType) {
        upgradeCorrectionLevel(userId, priorTaskType, mergeResult.oldLevel, mergeResult.mergedLevel)
      }
      // Paste is independent of the correction event — still log it
      if (norm.containsPastedContent && pasteType) {
        insertPasteLog({ userId, pasteType, pasteCharCount, pasteTribeHits, primaryTribe })
      }
      return
    }
  }

  // 8. Insert raw signal
  insertRawSignal({
    userId,
    sessionId,
    userMessageText: currentMessage,
    userMessageLength: currentMessage.length,
    priorTaskType,
    priorResponseLength: priorAssistantMessage.length,
    isContinuation,
    isCorrection,
    correctionLevel,
    correctionPhrases,
    containsPaste: norm.containsPastedContent,
    pasteType,
    pasteCharCount,
    pasteTribeHits,
    latencySeconds: latencyForSignal,
    latencyBucket,
    isRubberStamp,
  })

  // 9. Insert paste log (separate table for rolling 30-day window queries)
  if (norm.containsPastedContent && pasteType) {
    insertPasteLog({ userId, pasteType, pasteCharCount, pasteTribeHits, primaryTribe })
  }

  // 10. Update profile (fire-and-forget safe — synchronous SQLite, non-blocking)
  updateChannelBProfile(userId, {
    priorTaskType,
    isContinuation,
    isCorrection,
    correctionLevel,
    containsPaste: norm.containsPastedContent,
    pasteType,
    latencySeconds: latencyForSignal,
    latencyBucket,
    isRubberStamp,
  })
}
