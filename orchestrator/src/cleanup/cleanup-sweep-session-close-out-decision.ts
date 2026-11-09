// concern: closed session sweep decision
/** Decides whether the machine may finish one recorded session close-out. */

export type SessionCloseOutSweepFacts = {
  clean: boolean
  closedAt: number
  lastSeenAt: number | null
  sweptAt: number | null
}

export type SessionCloseOutSweepDecision =
  | { action: 'sweep' }
  | { action: 'skip'; reason: 'already-swept' | 'unclean' | 'resumed' }

export function decideSessionCloseOutSweep(
  facts: SessionCloseOutSweepFacts,
): SessionCloseOutSweepDecision {
  if (facts.sweptAt !== null) return { action: 'skip', reason: 'already-swept' }
  if (!facts.clean) return { action: 'skip', reason: 'unclean' }
  if (facts.lastSeenAt !== null && facts.lastSeenAt > facts.closedAt)
    return { action: 'skip', reason: 'resumed' }
  return { action: 'sweep' }
}
