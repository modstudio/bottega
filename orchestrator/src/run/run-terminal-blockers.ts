// concern: run-terminal-blockers

import { detectBlockers } from '../failure/failure.ts'

export type BlockerFacts = {
  declared: Array<{
    what: string
    why: string
    impact: string | null
  }>
  output: string
}

export type BlockerRow = {
  what: string
  why: string
  impact: string | null
  source: 'declared' | 'detected'
  kind: string | null
}

/**
 * Blockers come from every job, not only the ones with a contract. The runs
 * that first reported them were review lenses, which carry no contract, so a
 * structured field alone would have caught none; they said it in prose and
 * carried on. Declared and detected rows are stored side by side and kept
 * distinguishable, as measured and claimed facts are: one is the worker's own
 * account, the other is our reading of its prose.
 *
 * A declared blocker gets the first kind the detector recognises in the
 * worker's what and why. An unrecognised blocker is still recorded with a
 * null kind rather than discarded.
 *
 * Detect output only when nothing was declared. A worker that filled the
 * structured field has already reported the blocker, so adding a guess from
 * its output would count one blocker twice.
 */
export function blockersToRecord(facts: BlockerFacts): BlockerRow[] {
  if (facts.declared.length) {
    return facts.declared.map((blocker) => {
      const [known] = detectBlockers(`${blocker.what}\n${blocker.why}`)
      return {
        ...blocker,
        source: 'declared',
        kind: known?.kind ?? null,
      }
    })
  }

  return detectBlockers(facts.output).map((blocker) => ({
    what: blocker.what,
    why: blocker.why,
    impact: null,
    source: 'detected',
    kind: blocker.kind,
  }))
}
