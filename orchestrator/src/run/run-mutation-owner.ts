// concern: run-mutation-owner
/** Decides whether the calling session owns a chain, without touching process or database state. */

export type RunMutationOwnerDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; code: 'owner-mismatch' }

export function runMutationOwnerDecision(input: {
  owner: string | null
  actor: string | null
}): RunMutationOwnerDecision {
  if (input.owner !== null && input.actor !== input.owner) {
    return { kind: 'refuse', code: 'owner-mismatch' }
  }
  return { kind: 'allow' }
}
