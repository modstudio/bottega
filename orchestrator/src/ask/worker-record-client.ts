// concern: confined worker hosted-record client
/** Reads existing hosted task routes with a host-owned credential that never enters the worker. */

import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
import { readEnvValues } from '../../../shared/env-values.ts'
import { recordRequestHeaders } from '../../../shared/record-request-headers.ts'
import { readRecordSessionTokenAsync } from '../../../shared/record-session.ts'

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

type WorkerHostedWorkflowText = {
  space_id?: string
  text: null | { id: string; stageRecordId: string; body: string; [key: string]: unknown }
  stage: { id: string; number: number }
  copy: null | { taskDocumentReference: string; [key: string]: unknown }
}

type WorkerHostedWorkflowStage = {
  space_id?: string
  flow: { taskId: string | null; taskKey: string | null; projectId: string }
}

type WorkerRecordCredential = () => Promise<string | null>

/** Credential seam replaced by DEV-2531's machine credential without changing broker policy. */
const workerRecordCredential: WorkerRecordCredential = () => readRecordSessionTokenAsync()

export type WorkerRecordClient = {
  task(identity: string, spaceId: string): Promise<WorkerHostedTaskDetail>
  workflowText(id: string, spaceId: string): Promise<WorkerHostedWorkflowText>
  workflowStage(id: string, spaceId: string): Promise<WorkerHostedWorkflowStage>
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
  const request = async <T>(path: string, spaceId: string): Promise<T> => {
    const token = await readCredential()
    if (!token) throw new Error('record session is missing or expired on the ask host')
    const response = await (dependencies.fetch ?? hostedApiFetch)(`${baseUrl}${path}`, {
      headers: recordRequestHeaders({ bearerToken: token, destinationSpaceId: spaceId }),
    })
    const value: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(errorMessage(value, response.status))
    return value as T
  }
  return {
    task: (identity, spaceId) => request(`/v1/tasks/${encodeURIComponent(identity)}`, spaceId),
    workflowText: (id, spaceId) =>
      request(`/v1/task-flow/texts/${encodeURIComponent(id)}`, spaceId),
    workflowStage: (id, spaceId) =>
      request(`/v1/task-flow/stages/${encodeURIComponent(id)}`, spaceId),
  }
}
