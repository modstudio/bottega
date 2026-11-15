// concern: review-same-change
/** Decides whether two observed ranges represent the same reviewable change. */

type ChangeFacts = {
  patchId: string | null
  zeroContextPatchId: string | null
  paths: readonly string[]
  message: string | null
}

type ReplayResult =
  | { kind: 'same-tree' }
  | { kind: 'different-tree' | 'conflict' }
  | { kind: 'unavailable'; reason: string }
  | null

export type SameChangeFacts = {
  reviewed: ChangeFacts
  current: ChangeFacts
  replay: ReplayResult
}

export type SameChangeDecision = {
  same: boolean
  basis: 'zero-context' | 'legacy' | 'replay' | 'different'
  messageChanged: boolean
  reason: string | null
}

const samePaths = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())

/** The only in-memory decision for comparing persisted and current change identities. */
export function sameChange(facts: SameChangeFacts): SameChangeDecision {
  const pathsMatch = samePaths(facts.reviewed.paths, facts.current.paths)
  const messageChanged = facts.reviewed.message !== facts.current.message
  if (
    pathsMatch &&
    facts.reviewed.zeroContextPatchId !== null &&
    facts.current.zeroContextPatchId !== null &&
    facts.reviewed.zeroContextPatchId === facts.current.zeroContextPatchId
  ) {
    return { same: true, basis: 'zero-context', messageChanged, reason: null }
  }
  if (
    pathsMatch &&
    (facts.reviewed.zeroContextPatchId === null || facts.current.zeroContextPatchId === null) &&
    facts.reviewed.patchId !== null &&
    facts.reviewed.patchId === facts.current.patchId
  ) {
    return { same: true, basis: 'legacy', messageChanged, reason: null }
  }
  if (facts.replay?.kind === 'same-tree') {
    return { same: true, basis: 'replay', messageChanged, reason: null }
  }
  const reason =
    facts.replay?.kind === 'unavailable'
      ? facts.replay.reason
      : facts.replay?.kind === 'conflict'
        ? 'change replay conflicted'
        : pathsMatch
          ? 'change identity differs'
          : 'path set differs'
  return { same: false, basis: 'different', messageChanged, reason }
}
