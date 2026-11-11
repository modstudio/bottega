// concern: hosted task-flow write client
/** Routes one task-flow intent through one service call's record write authority. */
import type { Database } from 'bun:sqlite'
import { projectByName } from '../project/projects.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import type { RecordTaskFlowClient } from './record-api-client-task-flow.ts'
import { requireProjectRecordDestination } from './record-project-destination-client.ts'
import type {
  TaskFlowIntent,
  TaskFlowIntentInput,
  TaskFlowIntentResult,
} from './record-task-flow-write-contract.ts'
import { applyRecordWriteAuthority } from './record-write-authority.ts'

export type TaskFlowWriteTarget = {
  projectName: string
  database: Database
  destination?: Promise<RecordRequestDestination>
}

export const taskFlowWriteTarget = (
  projectName: string,
  database: Database,
): TaskFlowWriteTarget => ({ projectName, database })

function destinationFor(
  target: TaskFlowWriteTarget,
  client: RecordTaskFlowClient,
): Promise<RecordRequestDestination> {
  if (!target.destination) {
    const project = projectByName(target.projectName, target.database)
    if (!project)
      throw new Error(`project ${target.projectName} is not registered; register it, then retry`)
    const identityClient = client.whoami
      ? { whoami: client.whoami.bind(client) }
      : recordApiClient()
    target.destination = requireProjectRecordDestination(
      project.name,
      project.settings,
      identityClient,
    ).then((destinationSpaceId) => ({ destinationSpaceId }))
  }
  return target.destination
}

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
  target: TaskFlowWriteTarget,
  client: RecordTaskFlowClient = recordApiClient(),
): Promise<TaskFlowIntentResult<K> | null> {
  return applyRecordWriteAuthority(
    {
      local: () => null,
      hosted: async () => {
        const destination = await destinationFor(target, client)
        const method = client[methodByIntent[intent]] as
          | ((
              body: TaskFlowIntentInput<K>,
              destination?: RecordRequestDestination,
            ) => Promise<TaskFlowIntentResult<K>>)
          | undefined
        if (!method)
          throw new Error(
            `record API predates the ${intent} task-flow write; release hosted-api, then retry`,
          )
        return method(input, destination)
      },
    },
    target.database,
  )
}
