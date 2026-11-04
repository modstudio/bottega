// concern: document-history-source
/** Decides whether revision history is authoritative locally or in the hosted record. */

export type DocHistorySource = 'hosted' | 'local'
export type HostedRevisionReadOutcome = 'revisions' | 'not-found' | 'failed'
export type HostedRevisionReadDecision = 'print-hosted' | 'read-local' | 'refuse'

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
