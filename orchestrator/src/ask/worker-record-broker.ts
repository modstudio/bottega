// concern: confined worker hosted-record broker
/** Gathers host-side run facts, applies scope policy, then performs one read. */

import { db } from '../database/db.ts'
import { cachedProjectSpaces } from '../project-space-cache.ts'
import { strictlyAuthenticatedWorkerRun } from './worker-auth.ts'
import {
  createWorkerRecordClient,
  type WorkerHostedTaskDetail,
  type WorkerRecordClient,
} from './worker-record-client.ts'
import {
  decideWorkerRecordReadScope,
  type WorkerRecordReadTarget,
  type WorkerRecordScopeFacts,
} from './worker-record-scope.ts'

type RunScopeRow = {
  status: string
  launch_key: string | null
  task_record_id: string | null
  project_record_id: string | null
  project: string
}

type WorkerReadDependencies = { client?: WorkerRecordClient }

function runScopeFacts(runId: string, token: string): WorkerRecordScopeFacts & { project: string } {
  const row = db()
    .query<RunScopeRow, [string]>(
      `SELECT r.status,r.launch_key,r.task_record_id,r.project_record_id,p.name project
       FROM run r JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(runId)
  const space = row ? (cachedProjectSpaces(db())[row.project] ?? null) : null
  return {
    authenticated: strictlyAuthenticatedWorkerRun(runId, token),
    runStatus: row?.status ?? null,
    runTaskId: row?.task_record_id ?? null,
    runTaskKey: row?.launch_key?.toUpperCase() ?? null,
    runProjectId: row?.project_record_id ?? null,
    runSpaceId: space,
    allowedTaskIds: row?.task_record_id ? [row.task_record_id] : [],
    allowedTaskKeys: row?.launch_key ? [row.launch_key.toUpperCase()] : [],
    project: row?.project ?? '(unknown project)',
  }
}

async function allowedTaskChain(
  facts: WorkerRecordScopeFacts,
  client: WorkerRecordClient,
): Promise<{ facts: WorkerRecordScopeFacts; details: Map<string, WorkerHostedTaskDetail> }> {
  const details = new Map<string, WorkerHostedTaskDetail>()
  assertAllowed(facts, {
    kind: 'task',
    taskId: facts.runTaskId,
    taskKey: facts.runTaskKey,
    projectId: facts.runProjectId,
    spaceId: facts.runSpaceId,
  })
  if (!facts.runTaskId || !facts.runSpaceId) return { facts, details }
  const ids: string[] = []
  const keys: string[] = []
  let identity: string | null = facts.runTaskId
  const seen = new Set<string>()
  while (identity && !seen.has(identity)) {
    seen.add(identity)
    const detail = await client.task(identity, facts.runSpaceId)
    ids.push(detail.task.id)
    keys.push(detail.task.key.toUpperCase())
    details.set(detail.task.id, detail)
    details.set(detail.task.key.toUpperCase(), detail)
    identity = detail.task.parent_id ?? detail.task.parent_key ?? null
  }
  return { facts: { ...facts, allowedTaskIds: ids, allowedTaskKeys: keys }, details }
}

function assertAllowed(facts: WorkerRecordScopeFacts, target: WorkerRecordReadTarget): void {
  const decision = decideWorkerRecordReadScope(facts, target)
  if (!decision.allowed) throw new Error(decision.reason)
}

function taskTarget(
  detail: WorkerHostedTaskDetail,
  facts: WorkerRecordScopeFacts,
  kind: WorkerRecordReadTarget['kind'],
): WorkerRecordReadTarget {
  return {
    kind,
    taskId: detail.task.id,
    taskKey: detail.task.key,
    projectId: detail.task.projectId ?? facts.runProjectId,
    spaceId: facts.runSpaceId,
  }
}

export async function readWorkerTask(
  runId: string,
  token: string,
  key: string,
  dependencies: WorkerReadDependencies = {},
): Promise<WorkerHostedTaskDetail> {
  const client = dependencies.client ?? createWorkerRecordClient()
  const chain = await allowedTaskChain(runScopeFacts(runId, token), client)
  const detail = chain.details.get(key.toUpperCase()) ?? chain.details.get(key)
  if (!detail) {
    assertAllowed(chain.facts, {
      kind: 'task',
      taskId: null,
      taskKey: key,
      projectId: chain.facts.runProjectId,
      spaceId: chain.facts.runSpaceId,
    })
    throw new Error('unreachable worker task scope decision')
  }
  assertAllowed(chain.facts, taskTarget(detail, chain.facts, 'task'))
  return detail
}

export async function readWorkerTaskDocument(
  runId: string,
  token: string,
  reference: string,
  dependencies: WorkerReadDependencies = {},
): Promise<Record<string, unknown>> {
  const client = dependencies.client ?? createWorkerRecordClient()
  const chain = await allowedTaskChain(runScopeFacts(runId, token), client)
  const label = /^([^/]+)\/(\d+)$/.exec(reference)
  const documents = [...new Set(chain.details.values())].flatMap((detail) =>
    detail.documents.map((document) => ({ detail, document })),
  )
  const found = documents.find(({ document }) =>
    label
      ? document.task_key.toUpperCase() === label[1]!.toUpperCase() &&
        Number(document.number) === Number(label[2])
      : document.id.toLowerCase() === reference.toLowerCase(),
  )
  if (!found) {
    const requestedKey = label?.[1] ?? null
    assertAllowed(chain.facts, {
      kind: 'task-document',
      taskId: null,
      taskKey: requestedKey,
      projectId: chain.facts.runProjectId,
      spaceId: chain.facts.runSpaceId,
    })
    throw new Error(`no task document ${reference}`)
  }
  assertAllowed(chain.facts, taskTarget(found.detail, chain.facts, 'task-document'))
  return found.document
}

export async function readWorkerWorkflowText(
  runId: string,
  token: string,
  id: string,
  dependencies: WorkerReadDependencies = {},
): Promise<Record<string, unknown>> {
  const client = dependencies.client ?? createWorkerRecordClient()
  const chain = await allowedTaskChain(runScopeFacts(runId, token), client)
  if (!chain.facts.runSpaceId) {
    assertAllowed(chain.facts, {
      kind: 'workflow-text',
      taskId: null,
      taskKey: null,
      projectId: null,
      spaceId: null,
    })
  }
  const text = await client.workflowText(id, chain.facts.runSpaceId!)
  const stage = await client.workflowStage(text.stage.id, chain.facts.runSpaceId!)
  assertAllowed(chain.facts, {
    kind: 'workflow-text',
    taskId: stage.flow.taskId,
    taskKey: stage.flow.taskKey,
    projectId: stage.flow.projectId,
    spaceId: text.space_id ?? stage.space_id ?? chain.facts.runSpaceId,
  })
  if (text.copy) return { kind: 'copied', id, documentReference: text.copy.taskDocumentReference }
  if (!text.text) throw new Error(`no workflow text attached-text:${id}`)
  return { kind: 'live', ...text.text }
}
