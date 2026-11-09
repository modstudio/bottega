// concern: context-write-adapter
/** Gathers store, task, claim, and pointer facts for the pure context write policy. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import { liveTaskClaimsOfSession } from '../board/board-claim-service.ts'
import { db, sessionId } from '../database/db.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'
import { projectForTaskKey, projects } from '../project/projects.ts'
import {
  type HubTaskPuller,
  type HubTaskReader,
  type HubTaskReference,
  pullHubTask,
  readHubTasks,
  taskKeyMap,
  taskReadRefusal,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'
import { productionWorkflowTextDocumentPorts } from '../workflow/workflow-text-copy.ts'
import { decodeContextItem } from './context-item-codec.ts'
import {
  type ContextItem,
  type ContextProfile,
  contextDropRefusal,
  contextWriteRefusal,
  holderOwnershipRefusal,
} from './doc-context-write.ts'
import { listDocsStore } from './doc-read-store.ts'
import { isScratchLocation } from './doc-resume-write.ts'

type ContextTask = HubTaskReference
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
  const pointer = value.trim()
  if (!pointer) return 'pointer must not be empty'
  if (isScratchLocation(pointer)) return 'scratch paths are not durable pointers'
  if (/^[A-Z][A-Z0-9]*-\d+\/\d+$/.test(pointer)) {
    const key = pointer.slice(0, pointer.indexOf('/'))
    try {
      const docs = await productionWorkflowTextDocumentPorts.list(key, PLATFORM_SLUG)
      return docs.some((doc) => doc.reference === pointer)
        ? null
        : `task document ${pointer} does not resolve`
    } catch (error) {
      return `task documents of ${key} could not be read (${(error as Error).message}); retry once the task store answers`
    }
  }
  const stored = storedPointerRefusal(pointer, database)
  if (stored !== undefined) return stored
  const pr = /^#?(\d+)$/.exec(pointer)
  if (
    pr &&
    database.query('SELECT 1 FROM pull_request_ci WHERE pr_number=? LIMIT 1').get(Number(pr[1]))
  )
    return null
  try {
    resolveCommitArgument(process.cwd(), pointer)
    return null
  } catch {}
  return `pointer ${JSON.stringify(pointer)} does not resolve as a task document, run, commit, pull request number, or doc-store record`
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
  return listDocsStore({ scope: 'context', subject: holder }, database).map((doc) =>
    decodeContextItem(holder, doc.slug, doc.body),
  )
}

function freshTaskRetry(project: string, key: string): string {
  return `${PLATFORM_SLUG} task show ${key} --project ${project} --fresh --json`
}

async function pullContextTask(
  project: string,
  key: string,
  ports: ContextFactsPorts,
): Promise<ContextTask> {
  try {
    const task = await ports.task(project, key)
    if (task?.project === project && task.key === key) return task
    const detail = task
      ? `fresh task read returned ${task.project}:${task.key}`
      : 'fresh task read found no task'
    throw new Error(detail)
  } catch (error) {
    const detail = withholdSecretShapedDetail(
      error instanceof Error ? error.message : String(error),
    )
    throw new Error(
      `could not read task ${key} for project ${project}: ${detail}; retry: ${freshTaskRetry(project, key)}`,
    )
  }
}

async function resolveContextTaskInProject(
  project: string,
  key: string,
  ports: ContextFactsPorts,
  knownTasks?: readonly ContextTask[],
): Promise<ContextTask> {
  let tasks = knownTasks
  if (!tasks) {
    try {
      tasks = await ports.tasks(project)
    } catch (error) {
      throw taskReadRefusal(project, error instanceof Error ? error.message : String(error))
    }
  }
  return (
    taskReferenceForProjectKey(taskKeyMap(tasks), project, key) ??
    (await pullContextTask(project, key, ports))
  )
}

/** Resolve a person-facing task key once into the stable identity context stores. */
export async function resolveContextTask(
  value: string,
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<ContextTask> {
  const key = value.trim().toUpperCase()
  const prefix = /^([A-Z][A-Z0-9]*)-/.exec(key)?.[1] ?? key.split('-', 1)[0] ?? key
  const project = projectForTaskKey(key, projects(undefined, database))
  if (!project) {
    throw new Error(
      `task key prefix ${JSON.stringify(prefix)} is not declared by exactly one registered project; inspect prefixes with ${PLATFORM_SLUG} project list --json`,
    )
  }
  return resolveContextTaskInProject(project.name, key, ports)
}

export function taskProfile(key: string, tasks: readonly ContextTask[]): ContextProfile {
  return tasks.some((task) => task.parent_key === key) ? 'epic' : 'task'
}

async function relatedContextTasks(input: {
  owner: string | null
  claims: readonly string[]
  task?: ContextTask
  projectTasks: readonly ContextTask[]
  database: Database
  ports: ContextFactsPorts
}): Promise<ContextTask[]> {
  const related: ContextTask[] = []
  if (!input.owner) {
    if (input.task?.parent_key) {
      related.push(
        await resolveContextTaskInProject(
          input.task.project,
          input.task.parent_key,
          input.ports,
          input.projectTasks,
        ),
      )
    }
    return related
  }
  for (const key of input.claims) {
    const claimed = await resolveContextTask(key, input.database, input.ports)
    related.push(claimed)
    if (claimed.parent_key) {
      related.push(
        await resolveContextTaskInProject(claimed.project, claimed.parent_key, input.ports),
      )
    }
  }
  return related
}

async function contextSetRefusal(
  input: { subject: string; slug: string; body: string; contextTask?: ContextTask },
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<string | null> {
  const item = decodeContextItem(input.subject, input.slug, input.body)
  const owner = input.subject.startsWith('session:') ? input.subject.slice(8) : null
  const task = input.subject.startsWith('task:') ? input.contextTask : undefined
  if (input.subject.startsWith('task:') && (!task || input.subject !== `task:${task.record_id}`)) {
    return `context item ${input.slug} refused: task holder requires its resolved task identity`
  }
  const ownership = holderOwnershipRefusal(input.subject, sessionId(database), input.slug)
  if (ownership) return ownership
  const claims = owner ? liveTaskClaimsOfSession(owner, Date.now(), database) : []
  const projectTasks = task ? await ports.tasks(task.project) : []
  const profile = task ? taskProfile(task.key, projectTasks) : 'session'
  const relatedTasks = await relatedContextTasks({
    owner,
    claims,
    task,
    projectTasks,
    database,
    ports,
  })
  const relatedHolders = [...new Set(relatedTasks.map((related) => `task:${related.record_id}`))]
  const refusal = contextWriteRefusal(item, {
    profile,
    siblings: storedItems(input.subject, database),
    related: [...new Set(relatedHolders)].flatMap((holder) => storedItems(holder, database)),
    pointerRefusal: item.kind === 'pointer' ? await ports.pointer(item.body, database) : null,
    claimedTask: claims[0] ?? null,
  })
  return refusal
}

export async function assertContextSetAllowed(input: {
  scope: string
  subject: string | null
  slug: string
  body: string
  contextTask?: ContextTask
}): Promise<void> {
  if (input.scope !== 'context') return
  const refusal = await contextSetRefusal({
    subject: input.subject ?? '',
    slug: input.slug,
    body: input.body,
    contextTask: input.contextTask,
  })
  if (refusal) throw new Error(refusal)
}

/** A context item leaves only through its owner and never as the last required item. */
export async function assertContextDropAllowed(
  doc: { scope: string; subject: string | null; slug: string; body: string },
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
  task?: ContextTask,
): Promise<void> {
  if (doc.scope !== 'context') return
  const holder = doc.subject ?? ''
  const refusal =
    holderOwnershipRefusal(holder, sessionId(database), doc.slug) ??
    contextDropRefusal(
      decodeContextItem(holder, doc.slug, doc.body),
      storedItems(holder, database),
      await contextProfileForHolder(holder, ports, task),
    )
  if (refusal) throw new Error(refusal)
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
