// concern: hosted task-flow client

import {
  REVISION_CONFLICT_CODE,
  revisionConflictErrorFromRecordApiError,
} from '../doc/doc-revision-conflict.ts'
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import {
  type HostedTaskFlow,
  type HostedTaskFlowStageList,
  hostedTaskFlowSchema,
  hostedTaskFlowStageListSchema,
  type TaskFlowStageListQuery,
} from './record-task-flow-contract.ts'
import {
  type TaskFlowComposeResult,
  type TaskFlowIntent,
  type TaskFlowIntentInput,
  type TaskFlowWriteResult,
  taskFlowComposeResultSchema,
  taskFlowWriteResultSchema,
} from './record-task-flow-write-contract.ts'

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>
const TASK_FLOW_WRITE_REFUSAL =
  'record API predates task-flow writes; release hosted-api, then retry'
export type RecordTaskFlowClient = {
  readTaskFlow?(
    selector: { taskKey?: string; flowRecordId?: string },
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlow>
  listTaskFlowStages?(
    selector: Omit<TaskFlowStageListQuery, 'limit'> & { limit?: number },
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlowStageList>
  composeTaskFlow?(
    input: TaskFlowIntentInput<'compose'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowComposeResult>
  updateTaskFlowStage?(
    input: TaskFlowIntentInput<'stage-update'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowWriteResult>
  advanceTaskFlow?(
    input: TaskFlowIntentInput<'advance'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowWriteResult>
  awaitTaskFlowRuling?(
    input: TaskFlowIntentInput<'await-ruling'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowWriteResult>
  abandonTaskFlow?(
    input: TaskFlowIntentInput<'abandon'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowWriteResult>
  attachTaskFlowText?(
    input: TaskFlowIntentInput<'attach-text'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowWriteResult>
  deleteTaskFlowText?(
    input: TaskFlowIntentInput<'delete-text'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowWriteResult>
  copyTaskFlowText?(
    input: TaskFlowIntentInput<'copy-text'>,
    destination?: RecordRequestDestination,
  ): Promise<TaskFlowWriteResult>
}
async function write<K extends TaskFlowIntent, T>(
  request: Request,
  intent: K,
  input: TaskFlowIntentInput<K>,
  schema: (body: unknown) => T,
  destination?: RecordRequestDestination,
): Promise<T> {
  try {
    return await request(`/v1/task-flow/${intent}`, {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema,
    })
  } catch (error) {
    if (error instanceof RecordApiRequestError && error.code === REVISION_CONFLICT_CODE)
      throw revisionConflictErrorFromRecordApiError(error)
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      (error.status === 404 || error.status === 405)
    )
      throw new Error(TASK_FLOW_WRITE_REFUSAL)
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
  listTaskFlowStages: (selector, destination) => {
    const query = new URLSearchParams()
    if (selector.projectId) query.set('projectId', selector.projectId)
    if (selector.number !== undefined) query.set('number', String(selector.number))
    if (selector.sessionId) query.set('sessionId', selector.sessionId)
    for (const state of selector.states ?? []) query.append('state', state)
    if (selector.taskKey) query.set('taskKey', selector.taskKey)
    if (selector.limit !== undefined) query.set('limit', String(selector.limit))
    return request(`/v1/task-flow/stages?${query}`, {
      ...destination,
      schema: (body) => hostedTaskFlowStageListSchema.parse(body),
    })
  },
  composeTaskFlow: (input, destination) =>
    write(
      request,
      'compose',
      input,
      (body) => taskFlowComposeResultSchema.parse(body),
      destination,
    ),
  updateTaskFlowStage: (input, destination) =>
    write(
      request,
      'stage-update',
      input,
      (body) => taskFlowWriteResultSchema.parse(body),
      destination,
    ),
  advanceTaskFlow: (input, destination) =>
    write(request, 'advance', input, (body) => taskFlowWriteResultSchema.parse(body), destination),
  awaitTaskFlowRuling: (input, destination) =>
    write(
      request,
      'await-ruling',
      input,
      (body) => taskFlowWriteResultSchema.parse(body),
      destination,
    ),
  abandonTaskFlow: (input, destination) =>
    write(request, 'abandon', input, (body) => taskFlowWriteResultSchema.parse(body), destination),
  attachTaskFlowText: (input, destination) =>
    write(
      request,
      'attach-text',
      input,
      (body) => taskFlowWriteResultSchema.parse(body),
      destination,
    ),
  deleteTaskFlowText: (input, destination) =>
    write(
      request,
      'delete-text',
      input,
      (body) => taskFlowWriteResultSchema.parse(body),
      destination,
    ),
  copyTaskFlowText: (input, destination) =>
    write(
      request,
      'copy-text',
      input,
      (body) => taskFlowWriteResultSchema.parse(body),
      destination,
    ),
})
