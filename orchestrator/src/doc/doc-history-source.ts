// concern: document-history-source
/** Decides whether revision history is authoritative locally or in the hosted record. */

export type DocHistorySource = 'hosted' | 'local'
export type HostedRevisionReadOutcome = 'revisions' | 'not-found' | 'failed'
export type HostedRevisionReadDecision = 'print-hosted' | 'read-local' | 'refuse'

export type DocHistoryPresentation<RevisionRow, Revision> = {
  revisions: RevisionRow[]
  resolve(identifier: string): string
  revision(identifier: string): Revision
  diff(a: string | undefined, b: string | undefined): string
}

export function docDiffPair<T>(
  revisions: readonly T[],
  a: T | undefined,
  b: T | undefined,
): readonly [T, T] {
  const left = a ?? revisions[1]
  const right = b ?? revisions[0]
  if (left === undefined || right === undefined)
    throw new Error('doc diff needs two revisions; this address has fewer than two')
  return [left, right]
}

export function decideDocHistorySource(input: {
  hostedConfigured: boolean
  signedIn: boolean
}): DocHistorySource {
  return input.hostedConfigured && input.signedIn ? 'hosted' : 'local'
}

export function decideHostedRevisionRead(
  outcome: HostedRevisionReadOutcome,
): HostedRevisionReadDecision {
  if (outcome === 'revisions') return 'print-hosted'
  if (outcome === 'not-found') return 'read-local'
  return 'refuse'
}
