import { newRecordId } from '../../shared/record/schema.ts'
import { HostedSessionTransportError } from './hosted-session-send.ts'
import { HOSTED_UNREACHABLE_REMEDY } from './hosted-write-mode.ts'
import type { HostedPushChange } from './push-contract.ts'
import { hostedPushChanges } from './task-client.ts'

export type HostedChangeSendOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  recordSpace: string
  conflictRemedy: string
}

export class HostedChangeStageError extends Error {
  readonly stageIndex: number
  constructor(stageIndex: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.stageIndex = stageIndex
  }
}

export async function sendHostedChanges(
  subject: string,
  stages: HostedPushChange[][],
  options: HostedChangeSendOptions,
): Promise<void> {
  const { conflictRemedy, ...pushOptions } = options
  const prepared = stages.map((stage) =>
    stage.map((change) => ({
      ...change,
      change_id: change.change_id ?? newRecordId(),
    })),
  )
  const push = async (batch: HostedPushChange[]) => {
    try {
      return await hostedPushChanges(batch, pushOptions)
    } catch (error) {
      if (!(error instanceof HostedSessionTransportError)) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}. ${HOSTED_UNREACHABLE_REMEDY}`)
    }
  }
  const refuseRejected = (outcomes: Awaited<ReturnType<typeof hostedPushChanges>>) => {
    const refused = outcomes.find((outcome) => outcome.status === 'rejected')
    if (refused)
      throw new Error(
        `hosted change ${refused.id} was refused: ${refused.reason}; ` +
          `refresh ${subject} with \`${conflictRemedy}\` and retry`,
      )
  }
  for (const [stageIndex, stage] of prepared.entries()) {
    try {
      const outcomes = await push(stage)
      refuseRejected(outcomes)
    } catch (cause) {
      throw new HostedChangeStageError(stageIndex, cause)
    }
  }
}
