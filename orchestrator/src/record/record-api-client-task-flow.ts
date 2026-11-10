// concern: hosted task-flow client
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import {
  DocRevisionConflictError,
  REVISION_CONFLICT_CODE,
  type RevisionConflictReason,
} from '../doc/doc-revision-conflict.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import { type HostedTaskFlow, hostedTaskFlowSchema } from './record-task-flow-contract.ts'
import {
  type TaskFlowIntent,
  type TaskFlowIntentInput,
  type TaskFlowWriteResult,
  taskFlowWriteResultSchema,
} from './record-task-flow-write-contract.ts'

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>
export type RecordTaskFlowClient = {
  readTaskFlow?(
    selector: { taskKey?: string; flowRecordId?: string },
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlow>
  composeTaskFlow?(input: TaskFlowIntentInput<'compose'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
  updateTaskFlowStage?(input: TaskFlowIntentInput<'stage-update'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
  advanceTaskFlow?(input: TaskFlowIntentInput<'advance'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
  awaitTaskFlowRuling?(input: TaskFlowIntentInput<'await-ruling'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
  abandonTaskFlow?(input: TaskFlowIntentInput<'abandon'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
  attachTaskFlowText?(input: TaskFlowIntentInput<'attach-text'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
  deleteTaskFlowText?(input: TaskFlowIntentInput<'delete-text'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
  copyTaskFlowText?(input: TaskFlowIntentInput<'copy-text'>, destination?: RecordRequestDestination): Promise<TaskFlowWriteResult>
}
async function write<K extends TaskFlowIntent>(
  request: Request,
  intent: K,
  input: TaskFlowIntentInput<K>,
  destination?: RecordRequestDestination,
) {
  try {
    return await request(`/v1/task-flow/${intent}`, {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => taskFlowWriteResultSchema.parse(body),
    })
  } catch (error) {
    if (error instanceof RecordApiRequestError && error.code === REVISION_CONFLICT_CODE)
      throw new DocRevisionConflictError(
        error.message,
        error.condition,
        error.reason as RevisionConflictReason,
        error.currentRevision,
      )
    throw error
  }
}
export const recordTaskFlowClient = (request: Request): RecordTaskFlowClient => ({
  readTaskFlow: (selector, destination) => {
    const query = new URLSearchParams()
    if (selector.taskKey) query.set('taskKey', selector.taskKey)
    if (selector.flowRecordId) query.set('flowRecordId', selector.flowRecordId)
    return request(`/v1/task-flow?${query}`, {
      ...destination,
      schema: (body) => hostedTaskFlowSchema.parse(body),
    })
  },
  composeTaskFlow: (input, destination) => write(request, 'compose', input, destination),
  updateTaskFlowStage: (input, destination) => write(request, 'stage-update', input, destination),
  advanceTaskFlow: (input, destination) => write(request, 'advance', input, destination),
  awaitTaskFlowRuling: (input, destination) => write(request, 'await-ruling', input, destination),
  abandonTaskFlow: (input, destination) => write(request, 'abandon', input, destination),
  attachTaskFlowText: (input, destination) => write(request, 'attach-text', input, destination),
  deleteTaskFlowText: (input, destination) => write(request, 'delete-text', input, destination),
  copyTaskFlowText: (input, destination) => write(request, 'copy-text', input, destination),
})
