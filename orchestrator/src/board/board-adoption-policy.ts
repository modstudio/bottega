// concern: board-adoption-policy
/** Pure candidate selection, ordering, and completion decisions for hosted adoption. */
import type { MessageRow } from './board-store.ts'

export type LocalKind = 'notice' | 'question' | 'reply' | 'claim'
export type LedgerState = 'pending' | 'uploaded' | 'refused'
export type AdoptionClaimRow = {
  id: number
  project: string
  subject_kind: 'task' | 'path' | 'resource'
  subject_value: string
  holder_session: string | null
  note: string | null
  run_id: number | null
  lapses_at: string
  closed_at: string | null
}
export type AdoptionCandidate =
  | { kind: Exclude<LocalKind, 'claim'>; id: number; createdAt: string; row: MessageRow }
  | { kind: 'claim'; id: number; createdAt: string; row: AdoptionClaimRow }
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
  return states.every((state) => state === 'uploaded' || state === 'refused')
}
