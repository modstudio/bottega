// concern: hosted task-flow write client
/** Routes one task-flow intent through the install's record write authority. */
import { recordApiClient } from './record-api-client.ts'
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import type { RecordTaskFlowClient } from './record-api-client-task-flow.ts'
import type {
  type TaskFlowIntent,
  type TaskFlowIntentInput,
  type TaskFlowIntentResult,
} from './record-task-flow-write-contract.ts'
import { applyRecordWriteAuthority } from './record-write-authority.ts'

const methodByIntent = {
  compose: 'composeTaskFlow',
  'stage-update': 'updateTaskFlowStage',
  advance: 'advanceTaskFlow',
  'await-ruling': 'awaitTaskFlowRuling',
  abandon: 'abandonTaskFlow',
  adopt: 'adoptTaskFlow',
  'attach-text': 'attachTaskFlowText',
  'delete-text': 'deleteTaskFlowText',
  'copy-text': 'copyTaskFlowText',
} as const

export async function writeHostedTaskFlow<K extends TaskFlowIntent>(
  intent: K,
  input: TaskFlowIntentInput<K>,
  destination: RecordRequestDestination | undefined,
  client: RecordTaskFlowClient = recordApiClient(),
): Promise<TaskFlowIntentResult<K> | null> {
  return applyRecordWriteAuthority({
    local: () => null,
    hosted: async () => {
      const method = client[methodByIntent[intent]] as
        | ((body: TaskFlowIntentInput<K>) => Promise<TaskFlowIntentResult<K>>)
        | undefined
      if (!method)
        throw new Error(
          `record API predates the ${intent} task-flow write; release hosted-api, then retry`,
        )
      return method(input, destination)
    },
  })
}
