// concern: context-write-adapter
/** Gathers store, task, claim, and pointer facts for the pure context write policy. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { splitContextHolder } from '../../../shared/context-item-vocabulary.ts'
import {
  referenceNotVisibleRefusal,
  referenceStoreUnreachableRefusal,
} from '../../../shared/reference-refusal.ts'
import { parsePointerReference } from '../../../shared/reference.ts'
import { liveClaimsOfSession } from '../board/board-claim-service.ts'
import { db, sessionId } from '../database/db.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'
import { identityContext } from '../identity/identity-context.ts'
import { ResolutionMissError } from '../identity/identity-local-run.ts'
import { resolve } from '../identity/identity.ts'
import { projectForTaskKey, projects, taskKeyPrefix } from '../project/projects.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  type HubTaskPuller,
  type HubTaskReader,
  type HubTaskReference,
  pullHubTask,
  readHubTasks,
  resolveOrPullHubTaskReference,
  taskKeyMap,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'

import { productionWorkflowTextDocumentPorts } from '../workflow/workflow-text-copy.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import { listContextItems } from './context-item-store.ts'
import {
  type ContextItem,
  type ContextProfile,
  ContextWriteRefusalError,
  contextWriteRefusal,
  holderOwnershipRefusal,
} from './doc-context-write.ts'
import { isScratchLocation } from './doc-resume-write.ts'
import { readHostedDocReference } from './doc-hosted-client.ts'
import { taskContextHolder } from './doc-subjects.ts'

export type ContextTask = HubTaskReference
class ContextTaskPrefixError extends Error {
  readonly key: string
  readonly prefix: string

  constructor(key: string, prefix: string) {
    super(
      `task key prefix ${JSON.stringify(prefix)} is not declared by exactly one registered project; inspect prefixes with ${PLATFORM_SLUG} project list --json`,
    )
    this.name = 'ContextTaskPrefixError'
    this.key = key
    this.prefix = prefix
  }
}

export type ContextFactsPorts = {
  tasks: HubTaskReader
  task: HubTaskPuller
  pointer(value: string, database: Database): Promise<string | null>
}
export const CONTEXT_FACTS_PORTS_KEY = Symbol.for('orch.context-facts-ports')
const portsHolder = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}

async function pointerRefusal(value: string, database: Database): Promise<string | null> {
  try {
    await resolvedPointerTarget(value, database)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function resolveTaskDocumentPointer(pointer: string): Promise<string> {
  const key = pointer.slice(0, pointer.indexOf('/'))
  try {
    const docs = await productionWorkflowTextDocumentPorts.list(key, PLATFORM_SLUG)
    if (docs.some((doc) => doc.reference === pointer)) return pointer
    throw new ContextWriteRefusalError(`task document ${pointer} does not resolve`)
  } catch (error) {
    if (error instanceof ContextWriteRefusalError) throw error
    throw new Error(
      `task documents of ${key} could not be read (${(error as Error).message}); retry once the task store answers`,
    )
  }
}

/** Resolve the durable identity stored beside a pointer after the write gate accepts it. */
export async function resolvedPointerTarget(
  value: string,
  database: Database = db(),
): Promise<string> {
  const pointer = value.trim()
  // A pointer that cannot be a durable target is a policy refusal, not a retryable failure.
  if (!pointer) throw new ContextWriteRefusalError('pointer must not be empty')
  if (isScratchLocation(pointer))
    throw new ContextWriteRefusalError('scratch paths are not durable pointers')
  let parsed
  try {
    parsed = parsePointerReference(pointer)
  } catch (error) {
    throw new ContextWriteRefusalError(error instanceof Error ? error.message : String(error))
  }
  if (parsed.kind === 'task-document') return resolveTaskDocumentPointer(pointer)
  if (parsed.kind === 'run') {
    try {
      const resolved = await resolve(parsed.reference, identityContext(database), 'run')
      return resolved.recordId
    } catch (error) {
      if (error instanceof ResolutionMissError && /^[0-9]+$/.test(parsed.reference))
        throw new ContextWriteRefusalError(
          `${error.message}; for a commit, pass the full SHA`,
        )
      throw error
    }
  }
  if (parsed.kind === 'commit') return resolveCommitArgument(process.cwd(), parsed.sha)
  if (parsed.kind === 'pull-request') {
    const number = parsed.number
    if (
      number !== null &&
      database.query('SELECT 1 FROM pull_request_ci WHERE pr_number=? LIMIT 1').get(number)
    )
      return String(number)
    throw new ContextWriteRefusalError(
      referenceNotVisibleRefusal('this project', `pass #<n> for a pull request`),
    )
  }
  if (parsed.kind === 'doc') {
    try {
      await readHostedDocReference(parsed.address)
      return `doc:${parsed.address}`
    } catch (error) {
      if (error instanceof RecordApiRequestError && error.status === 404)
        throw new ContextWriteRefusalError(
          referenceNotVisibleRefusal('the document store', 'pass a visible doc reference'),
        )
      throw new Error(
        referenceStoreUnreachableRefusal(
          'the document store',
          error instanceof Error ? error.message : String(error),
        ),
      )
    }
  }
  if (parsed.kind === 'task' || parsed.kind === 'comment') {
    const { task: mirroredTask } = await resolveContextTaskWithProjectTasks(parsed.key, database)
    const task =
      parsed.kind === 'comment'
        ? ((await pullHubTask(mirroredTask.project, parsed.key)) ?? mirroredTask)
        : mirroredTask
    if (parsed.kind === 'comment') {
      const comments = task.commentIds
      if (!comments?.map(String).includes(parsed.id))
        throw new ContextWriteRefusalError(
          referenceNotVisibleRefusal(`task ${parsed.key}`, 'pass a comment id on that task'),
        )
    }
    return parsed.kind === 'task' ? `task:${task.key}` : `task:${task.key}#comment:${parsed.id}`
  }
  const table =
    parsed.kind === 'review-read'
      ? 'review_read'
      : parsed.kind === 'attached-text'
        ? 'workflow_text_copy'
        : 'probe'
  const column = parsed.kind === 'attached-text' ? 'workflow_text_record_id' : 'record_id'
  if (database.query(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(parsed.recordId))
    return pointer
  throw new ContextWriteRefusalError(
    referenceNotVisibleRefusal('this machine', 'pass the UUID of a visible record'),
  )
}

const productionContextFactsPorts: ContextFactsPorts = {
  tasks: readHubTasks,
  task: pullHubTask,
  pointer: pointerRefusal,
}
const defaultContextFactsPorts = () =>
  portsHolder[CONTEXT_FACTS_PORTS_KEY] ?? productionContextFactsPorts

export function storedItems(holder: string, database: Database): ContextItem[] {
  return listContextItems(holder, database)
}

export async function contextCursorOwner(holder: string, database: Database = db()) {
  const address = splitContextHolder(holder)
  if (address.holderKind !== 'cursor') return null
  const row = await taskFlowReadStore(database).stageByRecordId(address.holderId)
  return row ? { session_id: row.session_id, project: row.project } : null
}

/** Resolve a task while retaining the project task-list read used to resolve it. */
export async function resolveContextTaskWithProjectTasks(
  value: string,
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<{ task: ContextTask; tasks: ContextTask[] }> {
  const key = value.trim().toUpperCase()
  const prefix = taskKeyPrefix(key) ?? key.split('-', 1)[0] ?? key
  const project = projectForTaskKey(key, projects(undefined, database))
  if (!project) throw new ContextTaskPrefixError(key, prefix)
  let projectTasks: ContextTask[] = []
  const task = await resolveOrPullHubTaskReference(
    project.name,
    key,
    async (name) => {
      projectTasks = await ports.tasks(name)
      return projectTasks
    },
    ports.task,
  )
  return {
    task,
    tasks: projectTasks.some((candidate) => candidate.record_id === task.record_id)
      ? projectTasks
      : [...projectTasks, task],
  }
}

type ContextTaskByRecordId = { task: ContextTask | null; unreadable: string[] }

/** Resolve the stable task identity used in a context subject, naming every project whose tasks could not be read. */
export async function resolveContextTaskByRecordId(
  recordId: string,
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<ContextTaskByRecordId> {
  const readTasks = bestEffortProjectTaskReader(ports)
  const unreadable: string[] = []
  for (const project of projects(undefined, database)) {
    const tasks = await readTasks(project.name)
    if (!tasks) {
      unreadable.push(project.name)
      continue
    }
    const match = tasks.find((task) => task.record_id === recordId)
    if (match) return { task: match, unreadable }
  }
  return { task: null, unreadable }
}

export function taskProfile(key: string, tasks: readonly ContextTask[]): ContextProfile {
  return tasks.some((task) => task.parent_key === key) ? 'epic' : 'task'
}

function mirrorTask(
  tasks: readonly ContextTask[],
  project: string,
  key: string,
): ContextTask | null {
  return taskReferenceForProjectKey(taskKeyMap(tasks), project, key)
}

function bestEffortProjectTaskReader(ports: ContextFactsPorts) {
  const reads = new Map<string, Promise<readonly ContextTask[] | null>>()
  return (project: string) => {
    const existing = reads.get(project)
    if (existing) return existing
    const reading = ports.tasks(project).catch(() => null)
    reads.set(project, reading)
    return reading
  }
}

async function relatedContextTasks(input: {
  owner: string | null
  claims: readonly { key: string; project: string }[]
  task?: ContextTask
  projectTasks: readonly ContextTask[]
  ports: ContextFactsPorts
}): Promise<ContextTask[]> {
  const related: ContextTask[] = []
  if (!input.owner) {
    const parent = input.task?.parent_key
      ? mirrorTask(input.projectTasks, input.task.project, input.task.parent_key)
      : null
    if (parent) related.push(parent)
    return related
  }
  const readProject = bestEffortProjectTaskReader(input.ports)
  for (const claim of input.claims) {
    const tasks = await readProject(claim.project)
    if (!tasks) continue
    const claimed = mirrorTask(tasks, claim.project, claim.key)
    if (!claimed) continue
    related.push(claimed)
    if (claimed.parent_key) {
      const parent = mirrorTask(tasks, claimed.project, claimed.parent_key)
      if (parent) related.push(parent)
    }
  }
  return related
}

async function contextSetRefusal(
  input: { holder: string; item: ContextItem; contextTask?: ContextTask },
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<string | null> {
  const item = input.item
  const owner = input.holder.startsWith('session:') ? input.holder.slice(8) : null
  const task = input.holder.startsWith('task:') ? input.contextTask : undefined
  if (
    input.holder.startsWith('task:') &&
    (!task || input.holder !== taskContextHolder(task.record_id))
  ) {
    return `context item ${item.id} refused: task holder requires its resolved task identity; write task context with ${PLATFORM_SLUG} agent context set --task <KEY>`
  }
  const ownership = holderOwnershipRefusal(
    input.holder,
    sessionId(database),
    item.id,
    (await contextCursorOwner(input.holder, database))?.session_id,
  )
  if (ownership) return ownership
  const claims = owner
    ? liveClaimsOfSession(owner, Date.now(), database)
        .filter((claim) => claim.subject.kind === 'task')
        .map((claim) => ({ key: claim.subject.value, project: claim.project }))
    : []
  const projectTasks = task ? await ports.tasks(task.project) : []
  const profile = task ? taskProfile(task.key, projectTasks) : 'session'
  const relatedTasks = await relatedContextTasks({
    owner,
    claims,
    task,
    projectTasks,
    ports,
  })
  const relatedHolders = [
    ...new Set(relatedTasks.map((related) => taskContextHolder(related.record_id))),
  ]
  const refusal = contextWriteRefusal(item, {
    profile,
    siblings: storedItems(input.holder, database),
    related: [...new Set(relatedHolders)].flatMap((holder) => storedItems(holder, database)),
    pointerRefusal: item.kind === 'pointer' ? await ports.pointer(item.body, database) : null,
    claimedTask: claims[0]?.key ?? null,
  })
  return refusal
}

export async function assertContextSetAllowed(input: {
  holder: string
  item: ContextItem
  contextTask?: ContextTask
}): Promise<void> {
  const refusal = await contextSetRefusal(input)
  if (refusal) throw new ContextWriteRefusalError(refusal)
}

/** A context item leaves only through its owner. */
export async function assertContextDropAllowed({
  item,
  database = db(),
}: {
  item: ContextItem
  database?: Database
}): Promise<void> {
  const refusal = holderOwnershipRefusal(
    item.holder,
    sessionId(database),
    item.id,
    (await contextCursorOwner(item.holder, database))?.session_id,
  )
  if (refusal) throw new ContextWriteRefusalError(refusal)
}

export async function contextProfileForHolder(
  subject: string,
  ports = defaultContextFactsPorts(),
  task?: ContextTask,
) {
  const address = splitContextHolder(subject)
  if (address.holderKind === 'session' || address.holderKind === 'cursor') return 'session' as const
  if (!task) return 'task' as const
  return taskProfile(task.key, await ports.tasks(task.project))
}
