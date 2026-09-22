// concern: run-terminal-blockers

export type BlockerFacts = {
  declared: Array<{
    what: string
    why: string
    impact?: string | null
    kind: string | null
  }>
  detected: Array<{
    what: string
    why: string
    kind: string | null
  }>
}

export type BlockerRow = {
  what: string
  why: string
  impact: string | null
  source: 'declared' | 'detected'
  kind: string | null
}

export function blockersToRecord(facts: BlockerFacts): BlockerRow[] {
  if (facts.declared.length) {
    return facts.declared.map((blocker) => ({
      what: blocker.what,
      why: blocker.why,
      impact: blocker.impact ?? null,
      source: 'declared',
      kind: blocker.kind,
    }))
  }

  // Detected only where nothing was declared: a worker that filled the
  // field in has already told us, and adding our guess beside its answer
  // would double-count one blocker.
  return facts.detected.map((blocker) => ({
    what: blocker.what,
    why: blocker.why,
    impact: null,
    source: 'detected',
    kind: blocker.kind,
  }))
}
