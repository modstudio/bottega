// concern: checkpoint schedule
/** Pure decision for scheduled and preservation-triggered run checkpoints. */

export type CheckpointTrigger = 'scheduled' | 'limit'

export function decideCheckpoint(input: {
  due: boolean
  inFlightExecutions: number
  trigger: CheckpointTrigger
}): 'take' | 'defer' | 'none' {
  if (!input.due) return 'none'
  if (input.trigger === 'scheduled' && input.inFlightExecutions > 0) return 'defer'
  return 'take'
}

export type CheckpointSchedule<T> = {
  request(trigger: CheckpointTrigger): T | null
  executionStarted(): void
  executionFinished(): void
}

export function createCheckpointSchedule<T>(
  take: (trigger: CheckpointTrigger) => T,
): CheckpointSchedule<T> {
  let due = false
  let inFlightExecutions = 0
  const request = (trigger: CheckpointTrigger): T | null => {
    if (trigger === 'scheduled') due = true
    const decision = decideCheckpoint({
      due: trigger === 'limit' || due,
      inFlightExecutions,
      trigger,
    })
    if (decision !== 'take') return null
    if (trigger === 'scheduled') due = false
    return take(trigger)
  }
  return {
    request,
    executionStarted() {
      inFlightExecutions += 1
    },
    executionFinished() {
      inFlightExecutions = Math.max(0, inFlightExecutions - 1)
      if (due) request('scheduled')
    },
  }
}
