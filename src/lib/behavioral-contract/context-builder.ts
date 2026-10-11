import { getActiveDirectives } from './detector.js'

export function buildBehavioralContractBlock(userId: string): string | null {
  const directives = getActiveDirectives(userId)
  if (directives.length === 0) return null

  const lines = directives.slice(0, 12).map(d => `  • ${d.directive_value}`)
  return `[EXPLICIT USER PREFERENCES — highest priority, never override with inference]\n${lines.join('\n')}`
}
