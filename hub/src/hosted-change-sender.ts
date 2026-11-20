import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { HOSTED_UNREACHABLE_REMEDY } from './hosted-write-mode.ts'
import type { HostedPushChange } from './push-contract.ts'
import { hostedPushChanges } from './task-client.ts'
import type { HostedTaskWriteOptions } from './task-write-destination.ts'

export async function sendHostedChanges(
  taskKey: string,
  changes: HostedPushChange[],
  options: HostedTaskWriteOptions & { recordSpace: string },
): Promise<void> {
  let outcomes: Awaited<ReturnType<typeof hostedPushChanges>>
  try {
    outcomes = await hostedPushChanges(
      changes.map((change) => ({ ...change, change_id: change.change_id ?? newRecordId() })),
      options,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}. ${HOSTED_UNREACHABLE_REMEDY}`)
  }
  const refused = outcomes.find((outcome) => outcome.status === 'rejected')
  if (refused)
    throw new Error(
      `hosted change ${refused.id} was refused: ${refused.reason}; ` +
        `refresh the record with \`${PLATFORM_SLUG} task show ${taskKey}\` and retry`,
    )
}
