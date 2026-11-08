// concern: machine update recovery policy
/** Decides which installed state remains valid after an interrupted update. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type StoreJournalPositions = { orchestrator: number; hub: number }
export type SwappedUpdateState =
  | { kind: 'checkout'; target: string; priorCommit: string }
  | { kind: 'distribution'; installedBinary: string; priorBinary: string }

export type MachineUpdateRecoveryDecision =
  | { action: 'restore'; message: string }
  | { action: 'keep'; message: string }
  | { action: 'manual'; message: string }

function stateName(swapped: SwappedUpdateState): string {
  return swapped.kind === 'checkout'
    ? `main at ${swapped.priorCommit}`
    : `the prior binary at ${swapped.priorBinary}`
}

export function decideMachineUpdateRecovery(input: {
  before: StoreJournalPositions
  after?: StoreJournalPositions | null
  swapped: SwappedUpdateState
  restoreFailure?: string
}): MachineUpdateRecoveryDecision {
  if (input.restoreFailure) {
    const restoring =
      input.swapped.kind === 'checkout'
        ? `restoring main to ${input.swapped.priorCommit}`
        : `restoring the prior binary at ${input.swapped.priorBinary}`
    const remedy =
      input.swapped.kind === 'checkout'
        ? `manually run git -C ${input.swapped.target} reset --keep ${input.swapped.priorCommit}`
        : `manually rename ${input.swapped.priorBinary} to ${input.swapped.installedBinary}`
    return {
      action: 'manual',
      message: `${restoring} failed: ${input.restoreFailure}; ${remedy}, then ${PLATFORM_SLUG} machine update`,
    }
  }
  if (!input.after) {
    return {
      action: 'manual',
      message: `the store journal positions could not be read; leave the new state in place and rerun ${PLATFORM_SLUG} machine update`,
    }
  }
  const moved =
    input.before.orchestrator !== input.after.orchestrator || input.before.hub !== input.after.hub
  return moved
    ? {
        action: 'keep',
        message: `the new state was kept because a store journal position moved; rerun ${PLATFORM_SLUG} machine update`,
      }
    : { action: 'restore', message: `restore ${stateName(input.swapped)}` }
}
