// concern: context-write-adapter
/** Gathers store, task, claim, and pointer facts for the pure context write policy. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { liveTaskClaimsOfSession } from '../board/board-claim-service.ts'
import { db, sessionId } from '../database/db.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'
import { type HubTaskReference, readHubTasks } from '../workflow/workflow-task-reference.ts'
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
  tasks(): Promise<ContextTask[]>
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
  tasks: () => readHubTasks(PLATFORM_SLUG) as Promise<ContextTask[]>,
  pointer: pointerRefusal,
}
const defaultContextFactsPorts = () =>
  portsHolder[CONTEXT_FACTS_PORTS_KEY] ?? productionContextFactsPorts

export function storedItems(holder: string, database: Database): ContextItem[] {
  return listDocsStore({ scope: 'context', subject: holder }, database).map((doc) =>
    decodeContextItem(holder, doc.slug, doc.body),
  )
}

export function taskProfile(key: string, tasks: readonly ContextTask[]): ContextProfile {
  return tasks.some((task) => task.parent_key === key) ? 'epic' : 'task'
}

async function contextSetRefusal(
  input: { subject: string; slug: string; body: string },
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
): Promise<string | null> {
  const item = decodeContextItem(input.subject, input.slug, input.body)
  const tasks = await ports.tasks()
  const taskKey = input.subject.startsWith('task:') ? input.subject.slice(5) : null
  const owner = input.subject.startsWith('session:') ? input.subject.slice(8) : null
  if (taskKey && !tasks.some((task) => task.key === taskKey && task.project === PLATFORM_SLUG)) {
    return `context item ${input.slug} refused: task:${taskKey} is not in the ${PLATFORM_SLUG} task store`
  }
  const ownership = holderOwnershipRefusal(input.subject, sessionId(database), input.slug)
  if (ownership) return ownership
  const claims = owner ? liveTaskClaimsOfSession(owner, Date.now(), database) : []
  const profile = taskKey ? taskProfile(taskKey, tasks) : 'session'
  const parent = taskKey ? tasks.find((task) => task.key === taskKey)?.parent_key : null
  const relatedHolders = owner
    ? claims.flatMap((key) => {
        const taskParent = tasks.find((task) => task.key === key)?.parent_key
        return [`task:${key}`, ...(taskParent ? [`task:${taskParent}`] : [])]
      })
    : parent
      ? [`task:${parent}`]
      : []
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
}): Promise<void> {
  if (input.scope !== 'context') return
  const refusal = await contextSetRefusal({
    subject: input.subject ?? '',
    slug: input.slug,
    body: input.body,
  })
  if (refusal) throw new Error(refusal)
}

/** A context item leaves only through its owner and never as the last required item. */
export async function assertContextDropAllowed(
  doc: { scope: string; subject: string | null; slug: string; body: string },
  database: Database = db(),
  ports: ContextFactsPorts = defaultContextFactsPorts(),
  lifecycleHolder?: string,
): Promise<void> {
  if (doc.scope !== 'context') return
  const holder = doc.subject ?? ''
  const refusal =
    (lifecycleHolder === holder
      ? null
      : holderOwnershipRefusal(holder, sessionId(database), doc.slug)) ??
    contextDropRefusal(
      decodeContextItem(holder, doc.slug, doc.body),
      storedItems(holder, database),
      await contextProfileForHolder(holder, ports),
    )
  if (refusal) throw new Error(refusal)
}

export async function contextProfileForHolder(subject: string, ports = defaultContextFactsPorts()) {
  if (subject.startsWith('session:')) return 'session' as const
  const key = subject.slice(5)
  return taskProfile(key, await ports.tasks())
}
