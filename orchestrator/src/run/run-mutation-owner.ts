// concern: run-mutation-owner
/** Decides whether the calling session owns or may adopt a chain mutation. */

import { ownerIsGone, UNJUDGED_OWNER_WINDOW_MS } from '../cleanup/cleanup-sweep-decisions.ts'

export const RUN_MUTATION_WINDOW_MS = UNJUDGED_OWNER_WINDOW_MS

export type RunMutationOwnerFacts = {
  owner: string | null
  actor: string | null
  ownerLastSeenAt: number | null
  chainLastActivityAt: number
  now: number
  windowMs: number
}

export function runMutationOwnerDecision(
  input: RunMutationOwnerFacts,
): 'owner' | 'adopt' | 'refuse' {
  if (input.owner === null || input.actor === input.owner) return 'owner'
  if (
    ownerIsGone({
      ownerSessionId: input.owner,
      ownerLastSeenAt: input.ownerLastSeenAt,
      runLastActivityAt: input.chainLastActivityAt,
      now: input.now,
      windowMs: input.windowMs,
    })
  )
    return 'adopt'
  return 'refuse'
}

export function joinMutationReason(reason: string | null, adoption: string | null): string | null {
  if (!adoption) return reason
  return reason ? `${adoption}; ${reason}` : adoption
}
