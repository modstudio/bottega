// concern: confined worker hosted-record client
/** Reads existing hosted task routes with a host-owned credential that never enters the worker. */

import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
import { readEnvValues } from '../../../shared/env-values.ts'
import { recordRequestHeaders } from '../../../shared/record-request-headers.ts'
import { readRecordSessionTokenAsync } from '../../../shared/record-session.ts'
import { RecordApiRequestError, responseCode } from '../record/record-api-client-response.ts'
import { recordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import type {
  HostedTaskFlowStageById,
  HostedTaskFlowTextById,
} from '../record/record-task-flow-contract.ts'

export type WorkerHostedTaskDetail = {
  task: Record<string, unknown> & {
    id: string
    key: string
    projectId?: string | null
    parent_id?: string | null
    parent_key?: string | null
  }
  comments: Array<Record<string, unknown>>
  documents: Array<
    Record<string, unknown> & { id: string; task_id?: string | null; task_key: string }
  >
}

type WorkerRecordCredential = () => Promise<string | null>

/** Credential seam replaced by DEV-2531's machine credential without changing broker policy. */
const workerRecordCredential: WorkerRecordCredential = () => readRecordSessionTokenAsync()

export type WorkerRecordClient = {
  task(identity: string, spaceId: string): Promise<WorkerHostedTaskDetail>
  workflowText(id: string, spaceId: string): Promise<HostedTaskFlowTextById | null>
  workflowStage(id: string, spaceId: string): Promise<HostedTaskFlowStageById | null>
}

type WorkerRecordClientDependencies = {
  credential?: WorkerRecordCredential
  fetch?: typeof fetch
  baseUrl?: string
}

function requiredBaseUrl(override?: string): string {
  const configured = override ?? readEnvValues(['BOTTEGA_HOSTED_URL']).BOTTEGA_HOSTED_URL
  if (!configured) throw new Error('hosted record is not configured; set BOTTEGA_HOSTED_URL')
  return configured.replace(/\/$/, '')
}

function errorMessage(value: unknown, status: number): string {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string')
    return value.error
  return `hosted record read failed with status ${status}`
}

export function createWorkerRecordClient(
  dependencies: WorkerRecordClientDependencies = {},
): WorkerRecordClient {
  const baseUrl = requiredBaseUrl(dependencies.baseUrl)
  const readCredential = dependencies.credential ?? workerRecordCredential
  const request = async <T>(
    path: string,
    init: RequestInit & {
      schema?: (body: unknown) => T
      destinationSpaceId?: string
    } = {},
  ): Promise<T> => {
    const token = await readCredential()
    if (!token) throw new Error('record session is missing or expired on the ask host')
    const response = await (dependencies.fetch ?? hostedApiFetch)(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        ...recordRequestHeaders({
          bearerToken: token,
          destinationSpaceId: init.destinationSpaceId,
        }),
      },
    })
    const value: unknown = await response.json().catch(() => null)
    if (!response.ok)
      throw new RecordApiRequestError(
        errorMessage(value, response.status),
        response.status >= 500 ? 'server' : 'refused',
        response.status,
        responseCode(value),
      )
    return init.schema ? init.schema(value) : (value as T)
  }
  const taskFlow = recordTaskFlowClient(request)
  return {
    task: (identity, spaceId) =>
      request(`/v1/tasks/${encodeURIComponent(identity)}`, { destinationSpaceId: spaceId }),
    workflowText: (id, spaceId) => taskFlow.readTaskFlowText!(id, { destinationSpaceId: spaceId }),
    workflowStage: (id, spaceId) =>
      taskFlow.readTaskFlowStage!(id, { destinationSpaceId: spaceId }),
  }
}
