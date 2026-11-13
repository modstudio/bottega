// concern: context-write-adapter
/** Gathers store, task, claim, and pointer facts for the pure context write policy. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { liveClaimsOfSession } from '../board/board-claim-service.ts'
import { db, sessionId } from '../database/db.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'
import { projectForTaskKey, projects, taskKeyPrefix } from '../project/projects.ts'
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
import { listContextItems } from './context-item-store.ts'
import {
  type ContextItem,
  type ContextProfile,
  ContextWriteRefusalError,
  contextDropRefusal,
  contextWriteRefusal,
  holderOwnershipRefusal,
} from './doc-context-write.ts'
import { isScratchLocation } from './doc-resume-write.ts'
import { isValidContextHolderSubject, taskContextHolder } from './doc-subjects.ts'

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
  if (/^[A-Z][A-Z0-9]*-\d+\/\d+$/.test(pointer)) return resolveTaskDocumentPointer(pointer)
  const stored = storedPointerRefusal(pointer, database)
  if (stored !== undefined) {
    if (stored) throw new ContextWriteRefusalError(stored)
    return pointer
  }
  const pr = /^#?(\d+)$/.exec(pointer)
  if (
    pr &&
    database.query('SELECT 1 FROM pull_request_ci WHERE pr_number=? LIMIT 1').get(Number(pr[1]))
  )
    return pr[1]!
  try {
    return resolveCommitArgument(process.cwd(), pointer)
  } catch {}
  throw new ContextWriteRefusalError(
    `pointer ${JSON.stringify(pointer)} does not resolve as a task document, run, commit, pull request number, or doc-store record`,
  )
}

function storedPointerRefusal(pointer: string, database: Database): string | null | undefined {
  if (/^doc:[0-9a-f-]{36}$/i.test(pointer)) {
    return database.query('SELECT 1 FROM doc WHERE record_id=?').get(pointer.slice(4))
      ? null
      : `doc-store record ${pointer} does not resolve`
  }
  if (!/^[0-9a-f-]{36}$/i.test(pointer) && !/^\d+$/.test(pointer)) return undefined
  return database
    .query('SELECT 1 FROM run WHERE record_id=? OR number=?')
    .get(pointer, Number(pointer) || -1)
    ? null
    : undefined
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

/** Resolve a person-facing task key once into the stable identity context stores. */
export async function resolveContextTask(
  value: string,
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<ContextTask> {
  const key = value.trim().toUpperCase()
  const prefix = taskKeyPrefix(key) ?? key.split('-', 1)[0] ?? key
  const project = projectForTaskKey(key, projects(undefined, database))
  if (!project) throw new ContextTaskPrefixError(key, prefix)
  return resolveOrPullHubTaskReference(project.name, key, ports.tasks, ports.task)
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
  const ownership = holderOwnershipRefusal(input.holder, sessionId(database), item.id)
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

/** A context item leaves only through its owner and never as the last required item. */
export async function assertContextDropAllowed({
  item,
  database = db(),
  ports = defaultContextFactsPorts(),
  task,
}: {
  item: ContextItem
  database?: Database
  ports?: ContextFactsPorts
  task?: ContextTask
}): Promise<void> {
  const holder = item.holder
  const refusal =
    holderOwnershipRefusal(holder, sessionId(database), item.id) ??
    (isValidContextHolderSubject(holder)
      ? contextDropRefusal(
          item,
          storedItems(holder, database),
          await contextProfileForHolder(holder, ports, task),
        )
      : null)
  if (refusal) throw new ContextWriteRefusalError(refusal)
}

export async function contextProfileForHolder(
  subject: string,
  ports = defaultContextFactsPorts(),
  task?: ContextTask,
) {
  if (subject.startsWith('session:')) return 'session' as const
  if (!task) return 'task' as const
  return taskProfile(task.key, await ports.tasks(task.project))
}
