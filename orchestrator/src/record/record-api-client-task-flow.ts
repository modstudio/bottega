// concern: hosted task-flow client

import {
  REVISION_CONFLICT_CODE,
  revisionConflictErrorFromRecordApiError,
} from '../doc/doc-revision-conflict.ts'
import type { RecordRequestDestination, RecordWriteDestination } from './record-api-client-paths.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  type HostedTaskFlow,
  type HostedTaskFlowObligationById,
  type HostedTaskFlowProjectReferenceCounts,
  type HostedTaskFlowStageById,
  type HostedTaskFlowStageList,
  type HostedTaskFlowTextById,
  hostedTaskFlowObligationByIdSchema,
  hostedTaskFlowProjectReferenceCountsSchema,
  hostedTaskFlowSchema,
  hostedTaskFlowStageByIdSchema,
  hostedTaskFlowStageListSchema,
  hostedTaskFlowTextByIdSchema,
  RECORD_TASK_FLOW_NOT_FOUND_CODE,
  type TaskFlowReadQueryInput,
  type TaskFlowStageListQueryInput,
} from './record-task-flow-contract.ts'
import {
  type TaskFlowAdoptResult,
  type TaskFlowComposeResult,
  type TaskFlowIntent,
  type TaskFlowIntentInput,
  type TaskFlowWriteResult,
  taskFlowAdoptResultSchema,
  taskFlowComposeResultSchema,
  taskFlowWriteResultSchema,
} from './record-task-flow-write-contract.ts'

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>
type TaskFlowStageListClientInput = Omit<
  TaskFlowStageListQueryInput,
  'keyless' | 'primaryInstance' | 'unlinked' | 'linked'
> & {
  keyless?: true
  primaryInstance?: true
  unlinked?: true
  linked?: true
}
const TASK_FLOW_WRITE_REFUSAL =
  'record API predates task-flow writes; release hosted-api, then retry'
export type RecordTaskFlowClient = {
  whoami?(): Promise<RecordIdentity>
  readTaskFlow?(
    selector: TaskFlowReadQueryInput,
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlow>
  listTaskFlowStages?(
    selector: Omit<TaskFlowStageListClientInput, 'limit'> & { limit?: number },
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlowStageList>
  readTaskFlowProjectReferenceCounts?(
    projectId: string,
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlowProjectReferenceCounts>
  readTaskFlowStage?(
    id: string,
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlowStageById | null>
  readTaskFlowText?(
    id: string,
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlowTextById | null>
  readTaskFlowObligation?(
    id: string,
    destination?: RecordRequestDestination,
  ): Promise<HostedTaskFlowObligationById | null>
  composeTaskFlow?(
    input: TaskFlowIntentInput<'compose'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowComposeResult>
  updateTaskFlowStage?(
    input: TaskFlowIntentInput<'stage-update'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowWriteResult>
  advanceTaskFlow?(
    input: TaskFlowIntentInput<'advance'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowWriteResult>
  awaitTaskFlowRuling?(
    input: TaskFlowIntentInput<'await-ruling'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowWriteResult>
  abandonTaskFlow?(
    input: TaskFlowIntentInput<'abandon'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowWriteResult>
  adoptTaskFlow?(
    input: TaskFlowIntentInput<'adopt'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowAdoptResult>
  attachTaskFlowText?(
    input: TaskFlowIntentInput<'attach-text'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowWriteResult>
  deleteTaskFlowText?(
    input: TaskFlowIntentInput<'delete-text'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowWriteResult>
  copyTaskFlowText?(
    input: TaskFlowIntentInput<'copy-text'>,
    destination: RecordWriteDestination,
  ): Promise<TaskFlowWriteResult>
}
async function readById<T>(
  request: Request,
  path: string,
  schema: (body: unknown) => T,
  destination?: RecordRequestDestination,
): Promise<T | null> {
  try {
    return await request(path, { ...destination, schema })
  } catch (error) {
    if (
      error instanceof RecordApiRequestError &&
      error.status === 404 &&
      error.code === RECORD_TASK_FLOW_NOT_FOUND_CODE
    )
      return null
    throw error
  }
}
async function write<K extends TaskFlowIntent, T>(
  request: Request,
  intent: K,
  input: TaskFlowIntentInput<K>,
  schema: (body: unknown) => T,
  destination: RecordWriteDestination,
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
function taskFlowReadClient(request: Request): Partial<RecordTaskFlowClient> {
  return {
    readTaskFlow: (selector, destination) => {
      const query = new URLSearchParams()
      if (selector.taskKey) query.set('taskKey', selector.taskKey)
      if (selector.flowRecordId) query.set('flowRecordId', selector.flowRecordId)
      if (selector.taskId) query.set('taskId', selector.taskId)
      return request(`/v1/task-flow?${query}`, {
        ...destination,
        schema: (body) => hostedTaskFlowSchema.parse(body),
      })
    },
    listTaskFlowStages: (selector, destination) => {
      const query = taskFlowStageListSearchParams(selector)
      return request(`/v1/task-flow/stages?${query}`, {
        ...destination,
        schema: (body) => hostedTaskFlowStageListSchema.parse(body),
      })
    },
    readTaskFlowProjectReferenceCounts: (projectId, destination) => {
      const query = new URLSearchParams({ projectId })
      return request(`/v1/task-flow/project-reference-counts?${query}`, {
        ...destination,
        schema: (body) => hostedTaskFlowProjectReferenceCountsSchema.parse(body),
      })
    },
    readTaskFlowStage: (id, destination) =>
      readById(
        request,
        `/v1/task-flow/stages/${encodeURIComponent(id)}`,
        (body) => hostedTaskFlowStageByIdSchema.parse(body),
        destination,
      ),
    readTaskFlowText: (id, destination) =>
      readById(
        request,
        `/v1/task-flow/texts/${encodeURIComponent(id)}`,
        (body) => hostedTaskFlowTextByIdSchema.parse(body),
        destination,
      ),
    readTaskFlowObligation: (id, destination) =>
      readById(
        request,
        `/v1/task-flow/obligations/${encodeURIComponent(id)}`,
        (body) => hostedTaskFlowObligationByIdSchema.parse(body),
        destination,
      ),
  }
}

function taskFlowStageListSearchParams(
  selector: Parameters<NonNullable<RecordTaskFlowClient['listTaskFlowStages']>>[0],
): URLSearchParams {
  const query = new URLSearchParams()
  const strings = {
    projectId: selector.projectId,
    sessionId: selector.sessionId,
    taskKey: selector.taskKey,
    workflow: selector.workflow,
    mode: selector.mode,
    workflowKey: selector.workflowKey,
    taskId: selector.taskId,
    openedMachineId: selector.openedMachineId,
    order: selector.order,
    cursor: selector.cursor,
  }
  for (const [name, value] of Object.entries(strings))
    if (value !== undefined) query.set(name, value)
  if (selector.number !== undefined) query.set('number', String(selector.number))
  for (const state of selector.states ?? []) query.append('state', state)
  for (const name of ['keyless', 'primaryInstance', 'unlinked', 'linked'] as const)
    if (selector[name]) query.set(name, 'true')
  if (selector.limit !== undefined) query.set('limit', String(selector.limit))
  return query
}

function taskFlowWriteClient(request: Request): Partial<RecordTaskFlowClient> {
  return {
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
      write(
        request,
        'advance',
        input,
        (body) => taskFlowWriteResultSchema.parse(body),
        destination,
      ),
    awaitTaskFlowRuling: (input, destination) =>
      write(
        request,
        'await-ruling',
        input,
        (body) => taskFlowWriteResultSchema.parse(body),
        destination,
      ),
    abandonTaskFlow: (input, destination) =>
      write(
        request,
        'abandon',
        input,
        (body) => taskFlowWriteResultSchema.parse(body),
        destination,
      ),
    adoptTaskFlow: (input, destination) =>
      write(request, 'adopt', input, (body) => taskFlowAdoptResultSchema.parse(body), destination),
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
  }
}

export const recordTaskFlowClient = (request: Request): RecordTaskFlowClient => ({
  ...taskFlowReadClient(request),
  ...taskFlowWriteClient(request),
})
