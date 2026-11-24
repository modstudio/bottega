// concern: confined worker hosted-record broker
/** Gathers host-side run facts, applies scope policy, then performs one read. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { projectKeepsOwnTracker } from '../../../shared/trackers.ts'
import { db } from '../database/db.ts'
import { parseProjectSettings } from '../project/project-read.ts'
import { cachedProjectSpaces } from '../project-space-cache.ts'
import type { ShownWorkflowText } from '../workflow/workflow-text-commands.ts'
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
  workerRecordReadScopeAllowsKey,
  workerRecordScopeName,
} from './worker-record-scope.ts'

type RunScopeRow = {
  status: string
  launch_key: string | null
  task_record_id: string | null
  project_record_id: string | null
  project: string
  settings: string | null
}

type WorkerReadDependencies = { client?: WorkerRecordClient }
export type WorkerTaskRead<Detail extends WorkerHostedTaskDetail = WorkerHostedTaskDetail> =
  Detail & { tracker_notice?: string }

type RunScopeFacts = WorkerRecordScopeFacts & { project: string; keepsOwnTracker: boolean }

function runScopeFacts(runId: string, token: string): RunScopeFacts {
  const row = db()
    .query<RunScopeRow, [string]>(
      `SELECT r.status,r.launch_key,r.task_record_id,r.project_record_id,p.name project,p.settings
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
    keepsOwnTracker: projectKeepsOwnTracker(parseProjectSettings(row?.settings ?? null).tracker),
  }
}

async function allowedTaskChain(
  facts: WorkerRecordScopeFacts,
  client: WorkerRecordClient,
): Promise<{ facts: WorkerRecordScopeFacts; details: Map<string, WorkerHostedTaskDetail> }> {
  const details = new Map<string, WorkerHostedTaskDetail>()
  requireAllowed(facts, {
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

function requireAllowed(facts: WorkerRecordScopeFacts, target: WorkerRecordReadTarget): void {
  const decision = decideWorkerRecordReadScope(facts, target)
  if (!decision.allowed) throw new Error(decision.reason)
}

function targetFor(
  facts: WorkerRecordScopeFacts,
  kind: WorkerRecordReadTarget['kind'],
  detail?: WorkerHostedTaskDetail,
  taskKey?: string | null,
): WorkerRecordReadTarget {
  return {
    kind,
    taskId: detail?.task.id ?? null,
    taskKey: detail?.task.key ?? taskKey ?? null,
    projectId: detail?.task.projectId ?? facts.runProjectId,
    spaceId: facts.runSpaceId,
  }
}

function requireProject(facts: RunScopeFacts, project?: string): void {
  if (project !== undefined && project !== facts.project)
    throw new Error(
      `read refused: requested project ${project} is outside run project ${facts.project} and ${workerRecordScopeName(facts)}`,
    )
}

function fixedWorkflowRefusal(facts: WorkerRecordScopeFacts, id: string): Error {
  return new Error(
    `read refused: workflow text ${id} was not found or is outside ${workerRecordScopeName(facts)}`,
  )
}

function attachWorkflowTextRemedy(): string {
  return `Attach the content to the cursor as workflow text with \`${PLATFORM_SLUG} workflow attach\`.`
}

function trackerHoldsTaskContentNotice(project: string): string {
  return `This task's body and documents live in project ${project}'s own tracker, not the record.`
}

function trackerTaskNotice(project: string): string {
  return `${trackerHoldsTaskContentNotice(project)} ${attachWorkflowTextRemedy()}`
}

function missingDocumentMessage(reference: string, facts: RunScopeFacts): string {
  const missing = `no task document ${reference} in ${workerRecordScopeName(facts)}`
  if (!facts.keepsOwnTracker) return missing
  return `${missing}. ${trackerHoldsTaskContentNotice(facts.project)} ${attachWorkflowTextRemedy()}`
}

export async function readWorkerTask(
  runId: string,
  token: string,
  key: string,
  project?: string,
  dependencies: WorkerReadDependencies = {},
): Promise<WorkerTaskRead> {
  const scope = runScopeFacts(runId, token)
  requireProject(scope, project)
  const client = dependencies.client ?? createWorkerRecordClient()
  const chain = await allowedTaskChain(scope, client)
  const detail = chain.details.get(key.toUpperCase()) ?? chain.details.get(key)
  requireAllowed(chain.facts, targetFor(chain.facts, 'task', detail, key))
  if (!detail) throw new Error(`no task ${key} in ${workerRecordScopeName(chain.facts)}`)
  return scope.keepsOwnTracker &&
    (detail.task.body == null || detail.task.body === '') &&
    detail.documents.length === 0
    ? { ...detail, tracker_notice: trackerTaskNotice(scope.project) }
    : detail
}

export async function readWorkerTaskDocument(
  runId: string,
  token: string,
  reference: string,
  project?: string,
  dependencies: WorkerReadDependencies = {},
): Promise<Record<string, unknown>> {
  const scope = runScopeFacts(runId, token)
  requireProject(scope, project)
  const client = dependencies.client ?? createWorkerRecordClient()
  const chain = await allowedTaskChain(scope, client)
  const label = /^([^/]+)\/(\d+)$/.exec(reference)
  if (label && !workerRecordReadScopeAllowsKey(chain.facts, label[1]!)) {
    requireAllowed(chain.facts, targetFor(chain.facts, 'task-document', undefined, label[1]))
  }
  const documents = [...new Set(chain.details.values())].flatMap((detail) =>
    detail.documents.map((document) => ({ detail, document })),
  )
  const found = documents.find(({ document }) =>
    label
      ? document.task_key.toUpperCase() === label[1]!.toUpperCase() &&
        Number(document.number) === Number(label[2])
      : document.id.toLowerCase() === reference.toLowerCase(),
  )
  if (!found) throw new Error(missingDocumentMessage(reference, { ...scope, ...chain.facts }))
  requireAllowed(chain.facts, targetFor(chain.facts, 'task-document', found.detail))
  return found.document
}

export async function readWorkerWorkflowText(
  runId: string,
  token: string,
  id: string,
  project?: string,
  dependencies: WorkerReadDependencies = {},
): Promise<ShownWorkflowText> {
  const scope = runScopeFacts(runId, token)
  requireProject(scope, project)
  const client = dependencies.client ?? createWorkerRecordClient()
  const chain = await allowedTaskChain(scope, client)
  if (!chain.facts.runSpaceId) {
    requireAllowed(chain.facts, {
      kind: 'workflow-text',
      taskId: null,
      taskKey: null,
      projectId: null,
      spaceId: null,
    })
  }
  try {
    const text = await client.workflowText(id, chain.facts.runSpaceId!)
    if (!text) throw fixedWorkflowRefusal(chain.facts, id)
    const stage = await client.workflowStage(text.stage.id, chain.facts.runSpaceId!)
    if (!stage) throw fixedWorkflowRefusal(chain.facts, id)
    requireAllowed(chain.facts, {
      kind: 'workflow-text',
      taskId: stage.flow.taskId,
      taskKey: stage.flow.taskKey,
      projectId: stage.flow.projectId,
      spaceId: text.space_id ?? stage.space_id ?? chain.facts.runSpaceId,
    })
    if (text.copy)
      return { kind: 'redirect', id, documentReference: text.copy.taskDocumentReference }
    if (!text.text) throw fixedWorkflowRefusal(chain.facts, id)
    return {
      kind: 'live',
      id,
      cursor: text.stage.number,
      stepSlug: text.text.stepSlug,
      body: text.text.body,
    }
  } catch (error) {
    console.error(
      `worker workflow text read ${id} failed on the ask host: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw fixedWorkflowRefusal(chain.facts, id)
  }
}
