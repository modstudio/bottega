// concern: context-write-adapter
/** Gathers store, task, claim, and pointer facts for the pure context write policy. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId } from '../database/db.ts'
import { readHubTasks, taskCommand, type HubTaskReference } from '../workflow/workflow-task-reference.ts'
import { decodeContextItem } from './context-item-codec.ts'
import {
  contextWriteRefusal,
  type ContextItem,
  type ContextProfile,
} from './doc-context-write.ts'
import { getDocStore, listDocsStore } from './doc-read-store.ts'
import { isScratchLocation } from './doc-resume-write.ts'

type ContextTask = HubTaskReference & { parent_key?: string | null }
export type ContextFactsPorts = {
  tasks(): Promise<ContextTask[]>
  pointer(value: string, database: Database): Promise<string | null>
}
export const CONTEXT_FACTS_PORTS_KEY = Symbol.for('orch.context-facts-ports')
const portsHolder = globalThis as typeof globalThis & { [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts }

async function gitCommitResolves(value: string): Promise<boolean> {
  const child = Bun.spawn(['git', 'rev-parse', '--verify', `${value}^{commit}`], {
    cwd: process.cwd(), stdout: 'ignore', stderr: 'ignore',
  })
  return (await child.exited) === 0
}

async function pointerRefusal(value: string, database: Database): Promise<string | null> {
  const pointer = value.trim()
  if (!pointer) return 'pointer must not be empty'
  if (isScratchLocation(pointer)) return 'scratch paths are not durable pointers'
  if (/^[A-Z][A-Z0-9]*-\d+\/\d+$/.test(pointer)) {
    try { await taskCommand(['task', 'doc', 'show', pointer, '--json']); return null } catch { return `task document ${pointer} does not resolve` }
  }
  if (/^doc:[0-9a-f-]{36}$/i.test(pointer)) {
    return database.query('SELECT 1 FROM doc WHERE record_id=?').get(pointer.slice(4)) ? null : `doc-store record ${pointer} does not resolve`
  }
  if (/^[0-9a-f-]{36}$/i.test(pointer) || /^\d+$/.test(pointer)) {
    if (database.query('SELECT 1 FROM run WHERE record_id=? OR number=?').get(pointer, Number(pointer) || -1)) return null
  }
  const pr = /^#?(\d+)$/.exec(pointer)
  if (pr && database.query('SELECT 1 FROM pull_request_ci WHERE pr_number=? LIMIT 1').get(Number(pr[1]))) return null
  if (await gitCommitResolves(pointer)) return null
  return `pointer ${JSON.stringify(pointer)} does not resolve as a task document, run, commit, pull request number, or doc-store record`
}

export const productionContextFactsPorts: ContextFactsPorts = {
  tasks: () => readHubTasks(PLATFORM_SLUG) as Promise<ContextTask[]>,
  pointer: pointerRefusal,
}
export const defaultContextFactsPorts = () => portsHolder[CONTEXT_FACTS_PORTS_KEY] ?? productionContextFactsPorts

function storedItems(holder: string, database: Database): ContextItem[] {
  return listDocsStore({ scope: 'context', subject: holder }, database).map((doc) =>
    decodeContextItem(holder, doc.slug, doc.body),
  )
}

function taskProfile(key: string, tasks: ContextTask[]): ContextProfile {
  return tasks.some((task) => task.parent_key === key) ? 'epic' : 'task'
}

function claimedTasks(owner: string, database: Database): string[] {
  return (database.query<{ subject_value: string }, [string]>(
    `SELECT subject_value FROM board_claim WHERE session_id=? AND subject_kind='task' AND closed_at IS NULL ORDER BY subject_value`,
  ).all(owner)).map((row) => row.subject_value)
}

export async function contextSetRefusal(
  input: { subject: string; slug: string; body: string },
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<string | null> {
  const item = decodeContextItem(input.subject, input.slug, input.body)
  const tasks = await ports.tasks()
  const taskKey = input.subject.startsWith('task:') ? input.subject.slice(5) : null
  const owner = input.subject.startsWith('session:') ? input.subject.slice(8) : null
  if (taskKey && !tasks.some((task) => task.key === taskKey && task.project === PLATFORM_SLUG)) {
    return `context item ${input.slug} refused: task:${taskKey} is not a ${PLATFORM_SLUG} hub task`
  }
  if (owner && owner !== sessionId(database)) {
    return `context item ${input.slug} refused: only owning session ${owner} may write session:${owner}`
  }
  const claims = owner ? claimedTasks(owner, database) : []
  const profile = taskKey ? taskProfile(taskKey, tasks) : 'session'
  const parent = taskKey ? tasks.find((task) => task.key === taskKey)?.parent_key : null
  const relatedHolders = owner
    ? claims.flatMap((key) => {
        const taskParent = tasks.find((task) => task.key === key)?.parent_key
        return [`task:${key}`, ...(taskParent ? [`task:${taskParent}`] : [])]
      })
    : parent ? [`task:${parent}`] : []
  const refusal = contextWriteRefusal(item, {
    profile,
    siblings: storedItems(input.subject, database),
    related: [...new Set(relatedHolders)].flatMap((holder) => storedItems(holder, database)),
    pointerRefusal: item.kind === 'pointer' ? await ports.pointer(item.body, database) : null,
    claimedTask: claims[0] ?? null,
  })
  return refusal
}

export async function contextProfileForHolder(subject: string, ports = defaultContextFactsPorts()) {
  if (subject.startsWith('session:')) return 'session' as const
  const key = subject.slice(5)
  return taskProfile(key, await ports.tasks())
}
