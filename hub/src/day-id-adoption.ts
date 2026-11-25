import type { HostedPushChange, HostedPushOutcome } from './push-contract.ts'

export type DayIdAdoptionDecision = { action: 'adopt'; hostedId: string } | { action: 'none' }

export function decideDayIdAdoption(
  change: HostedPushChange,
  outcome: HostedPushOutcome,
  thisMachineId: string | null,
): DayIdAdoptionDecision {
  if (change.table !== 'hub_day' || change.op !== 'upsert' || outcome.status !== 'rejected')
    return { action: 'none' }
  const conflict = outcome.conflict
  if (
    conflict?.code !== 'day-identity-conflict' ||
    conflict.existingId === change.id ||
    conflict.day !== change.row.day ||
    conflict.machineId === null ||
    conflict.machineId !== change.row.machine_id ||
    conflict.machineId !== thisMachineId
  )
    return { action: 'none' }
  return { action: 'adopt', hostedId: conflict.existingId }
}
