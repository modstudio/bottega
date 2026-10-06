// concern: board-adoption-policy
/** Pure candidate selection, ordering, and completion decisions for hosted adoption. */
export type LocalKind = 'notice' | 'question' | 'reply' | 'claim'
export type LedgerState = 'pending' | 'uploaded' | 'refused'
export type AdoptionCandidate = { kind: LocalKind; id: number; createdAt: string }
export type AdoptionCandidateFact = {
  candidate: AdoptionCandidate
  live: boolean
  accepted: boolean
  machine: boolean
  recorded: boolean
}

function orderCandidates(rows: AdoptionCandidate[]): AdoptionCandidate[] {
  const phase = (row: AdoptionCandidate) =>
    row.kind === 'reply' ? 1 : row.kind === 'claim' ? 2 : 0
  return [...rows].sort(
    (left, right) =>
      phase(left) - phase(right) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id - right.id,
  )
}

export function selectBoardAdoptionCandidates(facts: AdoptionCandidateFact[]): AdoptionCandidate[] {
  return orderCandidates(
    facts
      .filter((fact) => (fact.recorded || fact.live) && !fact.accepted && !fact.machine)
      .map((fact) => fact.candidate),
  )
}

export function mayMarkBoardHostedAdopted(states: LedgerState[]): boolean {
  return states.every(isTerminalLedgerState)
}

export function isTerminalLedgerState(state: LedgerState | undefined): boolean {
  return state === 'uploaded' || state === 'refused'
}

export type UploadErrorKind = 'refused' | 'unreachable' | 'unexpected'
export type UploadErrorDisposition = 'rate' | 'machine' | 'lasting' | 'unexpected'

export function uploadErrorDisposition(
  kind: UploadErrorKind,
  message: string,
): UploadErrorDisposition {
  if (kind !== 'refused') return 'unexpected'
  if (message.includes('board post rate limit reached; retry after the ten-minute author window'))
    return 'rate'
  if (message.includes('board authorMachineId is missing, invisible, or not owned by this user'))
    return 'machine'
  if (
    [
      'unknown or invisible board project',
      'row-level security',
      'not started by this user',
      'claim conflicts with:',
    ].some((text) => message.includes(text))
  )
    return 'lasting'
  return 'unexpected'
}
