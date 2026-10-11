export type LatencyBucket = 'invalid' | 'immediate' | 'quick' | 'medium' | 'slow' | 'session_break'

export function computeLatencySeconds(priorCreatedAt: string, currentTime: Date): number {
  const prior = new Date(priorCreatedAt).getTime()
  if (isNaN(prior)) return -1
  return Math.round((currentTime.getTime() - prior) / 1000)
}

export function bucketLatency(latencySeconds: number): LatencyBucket {
  if (latencySeconds < 2)      return 'invalid'
  if (latencySeconds <= 30)    return 'immediate'
  if (latencySeconds <= 300)   return 'quick'
  if (latencySeconds <= 1800)  return 'medium'
  if (latencySeconds <= 14400) return 'slow'
  return 'session_break'
}

export function isLatencyMeaningful(bucket: LatencyBucket): boolean {
  return bucket !== 'invalid' && bucket !== 'session_break'
}

export function detectRubberStamp(
  latencySeconds: number,
  priorResponseLength: number,
  isCorrection: boolean
): boolean {
  return (
    latencySeconds >= 2 &&
    latencySeconds < 5 &&
    priorResponseLength > 100 &&
    !isCorrection
  )
}
