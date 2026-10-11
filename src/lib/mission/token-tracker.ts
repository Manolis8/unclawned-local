/**
 * In-memory token accumulator for missions.
 * Each LLM call site logs in/out tokens; on mission completion a summary is printed
 * and written to missions.token_summary.
 */

export type TokenPhase =
  | 'ceo_planning'
  | 'ceo_synthesis'
  | 'mgr_planning'
  | 'mgr_synthesis'
  | 'worker'

interface PhaseStats {
  turns: number
  tokensIn: number
  tokensOut: number
}

interface MissionTokens {
  ceo_planning: PhaseStats
  ceo_synthesis: PhaseStats
  mgr_planning: PhaseStats
  mgr_synthesis: PhaseStats
  worker: PhaseStats
  runningTotal: number
}

function emptyPhase(): PhaseStats {
  return { turns: 0, tokensIn: 0, tokensOut: 0 }
}

function emptyMission(): MissionTokens {
  return {
    ceo_planning: emptyPhase(),
    ceo_synthesis: emptyPhase(),
    mgr_planning: emptyPhase(),
    mgr_synthesis: emptyPhase(),
    worker: emptyPhase(),
    runningTotal: 0,
  }
}

const _registry = new Map<string, MissionTokens>()

export function trackTokens(
  missionId: string,
  phase: TokenPhase,
  model: string,
  turn: number,
  tokensIn: number,
  tokensOut: number,
): void {
  if (!_registry.has(missionId)) _registry.set(missionId, emptyMission())
  const mt = _registry.get(missionId)!
  mt[phase].turns++
  mt[phase].tokensIn += tokensIn
  mt[phase].tokensOut += tokensOut
  mt.runningTotal += tokensIn + tokensOut

  console.log(
    `[tokens] mission=${missionId.slice(0, 8)} phase=${phase} turn=${turn}` +
    ` model=${model} in=${tokensIn} out=${tokensOut}` +
    ` mission_running_total=${mt.runningTotal}`
  )
}

export function finalizeMissionTokens(missionId: string): string {
  const mt = _registry.get(missionId)
  if (!mt) return JSON.stringify({ error: 'no token data' })

  const GROK_IN_PER_MTOK = 2.00
  const GROK_OUT_PER_MTOK = 6.00

  const totalIn = Object.values(mt).filter((v): v is PhaseStats => typeof v === 'object' && 'tokensIn' in v)
    .reduce((sum, p) => sum + p.tokensIn, 0)
  const totalOut = Object.values(mt).filter((v): v is PhaseStats => typeof v === 'object' && 'tokensOut' in v)
    .reduce((sum, p) => sum + p.tokensOut, 0)
  const totalTurns = Object.values(mt).filter((v): v is PhaseStats => typeof v === 'object' && 'turns' in v)
    .reduce((sum, p) => sum + p.turns, 0)

  const estCostUsd = (totalIn * GROK_IN_PER_MTOK + totalOut * GROK_OUT_PER_MTOK) / 1_000_000

  const pad = (n: number, w = 9) => String(n).padStart(w)
  const padL = (s: string, w = 18) => s.padEnd(w)

  const banner = '━'.repeat(60)
  const divider = '─'.repeat(60)
  const lines: string[] = [
    banner,
    `MISSION COST SUMMARY: ${missionId.slice(0, 8)}`,
    banner,
    `${padL('Phase')}  ${'Turns'.padStart(5)}  ${'In'.padStart(9)}  ${'Out'.padStart(9)}`,
    divider,
  ]

  const phases: Array<[TokenPhase, string]> = [
    ['ceo_planning',   'CEO planning'],
    ['ceo_synthesis',  'CEO synthesis'],
    ['mgr_planning',   'Manager planning'],
    ['mgr_synthesis',  'Manager synthesis'],
    ['worker',         'Workers'],
  ]

  for (const [key, label] of phases) {
    const p = mt[key]
    if (p.turns === 0) continue
    lines.push(`${padL(label)}  ${pad(p.turns, 5)}  ${pad(p.tokensIn)}  ${pad(p.tokensOut)}`)
  }

  lines.push(divider)
  lines.push(`${padL('TOTAL')}  ${pad(totalTurns, 5)}  ${pad(totalIn)}  ${pad(totalOut)}`)
  lines.push(`Est cost: ~$${estCostUsd.toFixed(3)} at grok-4.5 pricing ($2/$6 per MTok in/out)`)
  lines.push(banner)

  const summary = lines.join('\n')
  console.log('\n' + summary)

  _registry.delete(missionId)

  return JSON.stringify({
    phases: Object.fromEntries(phases.map(([k, label]) => [label, mt[k]])),
    totalIn,
    totalOut,
    totalTurns,
    estCostUsd: parseFloat(estCostUsd.toFixed(4)),
  })
}
