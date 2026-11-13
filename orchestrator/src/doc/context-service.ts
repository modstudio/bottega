// concern: context-service
/** Owns context item reads and mutations over the document store. */
import type { Database } from 'bun:sqlite'
import { sessionId, writableDb } from '../database/db.ts'
import {
  assertContextDropAllowed,
  assertContextSetAllowed,
  contextProfileForHolder,
  resolveContextTask,
} from './context-write-adapter.ts'
import {
  getContextItem,
  listContextHolders,
  listContextItems,
  removeLocalContextHolder,
  removeLocalContextItem,
  setLocalContextItem,
} from './context-item-store.ts'
import {
  type ContextItemKind,
  type ContextTaskIdentity,
  missingContextKinds,
} from './doc-context-write.ts'
import { taskContextHolder } from './doc-subjects.ts'

export type ContextHolderSelection = { task?: string; session?: string }

type ResolvedContextHolder = { holder: string; task: ContextTaskIdentity | null }

async function resolveContextHolder(
  selection: ContextHolderSelection,
): Promise<ResolvedContextHolder> {
  if (selection.task && selection.session) throw new Error('use --task or --session, not both')
  if (selection.task) {
    const task = await resolveContextTask(selection.task)
    return { holder: taskContextHolder(task.record_id), task }
  }
  const owner = selection.session ?? sessionId()
  if (!owner) throw new Error('no caller session; pass --task KEY or --session ID')
  return { holder: `session:${owner}`, task: null }
}

export async function getContext(selection: ContextHolderSelection) {
  const { holder, task } = await resolveContextHolder(selection)
  const profile = await contextProfileForHolder(holder, undefined, task ?? undefined)
  const items = listContextItems(holder)
  return {
    holder,
    task: task?.key ?? null,
    profile,
    items,
    missingRequired: missingContextKinds(items, profile),
  }
}

/** Reads one item's current revision on a resolved holder for compare-and-set writes. */
export async function contextItemRevision(
  selection: ContextHolderSelection & { id: string },
): Promise<string | undefined> {
  const { holder } = await resolveContextHolder(selection)
  return getContextItem(holder, selection.id)?.revision
}

export function sessionContextItems(session: string, database: Database) {
  const holder = `session:${session}`
  return listContextItems(holder, database)
}

/** Read one task's context items through the document-store owner. */
export function taskContextItems(task: ContextTaskIdentity, database: Database) {
  const holder = taskContextHolder(task.record_id)
  return listContextItems(holder, database)
}

/** Removes every item on a task holder; a whole-holder clear is not blocked by required kinds. */
export async function clearTaskContext(input: { task: string }) {
  const { holder, task } = await resolveContextHolder(input)
  if (!task) throw new Error('task context clear requires --task')
  writableDb()
  const removed = removeLocalContextHolder(holder)
  return { holder, task: task.key, removed }
}

export function sessionContextHolders(database: Database) {
  return listContextHolders('session', database).map(({ holder, holderId, updatedAt, items }) => ({
    holder,
    session: holderId,
    updatedAt,
    items,
  }))
}

async function dropSessionContextItemForLifecycle(input: {
  session: string
  id: string
  expectedRevision: string
  reason: string
}) {
  const holder = `session:${input.session}`
  writableDb()
  const removed = removeLocalContextItem(holder, input.id, input.expectedRevision)
  return { holder, id: input.id, removed }
}

export type SessionContextDropResult = {
  item: ReturnType<typeof sessionContextItems>[number]
  removed: boolean
  error: string | null
}

/** The single lifecycle loop for dropping selected items from one session holder. */
export async function dropSessionContextItemsForLifecycle(input: {
  session: string
  items: ReturnType<typeof sessionContextItems>
  reason: string
  dryRun?: boolean
}): Promise<SessionContextDropResult[]> {
  const results: SessionContextDropResult[] = []
  for (const item of input.items) {
    if (item.revision === null) {
      results.push({ item, removed: false, error: 'context item revision is unavailable' })
      continue
    }
    if (input.dryRun) {
      results.push({ item, removed: false, error: null })
      continue
    }
    try {
      const result = await dropSessionContextItemForLifecycle({
        session: input.session,
        id: item.id,
        expectedRevision: item.revision,
        reason: input.reason,
      })
      results.push({ item, removed: result.removed, error: null })
    } catch (error) {
      results.push({
        item,
        removed: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function setContextItem(
  input: ContextHolderSelection & {
    id: string
    kind: ContextItemKind
    source: string
    body: string
    expectedRevision?: string
  },
) {
  const { holder, task } = await resolveContextHolder(input)
  writableDb()
  const questionNumber = /^(?:q)(\d+)$/.exec(input.source.trim())
  const item = {
    holder,
    id: input.id,
    kind: input.kind,
    source: input.source,
    body: input.body,
    questionNumber:
      ['ruling', 'position'].includes(input.kind) && questionNumber
        ? Number(questionNumber[1])
        : null,
    target: input.kind === 'pointer' ? input.body.trim() : null,
  }
  await assertContextSetAllowed({ holder, item, contextTask: task ?? undefined })
  const written = setLocalContextItem({
    holder,
    slug: input.id,
    kind: input.kind,
    body: input.body,
    source: input.source,
    questionNumber: item.questionNumber,
    target: item.target,
    expectedRevision: input.expectedRevision,
  })
  return {
    task: task?.key ?? null,
    holder: written.holder,
    id: written.id,
    kind: written.kind,
    source: written.source,
    body: written.body,
    revision: written.revision,
  }
}

export async function dropContextItem(
  input: ContextHolderSelection & {
    id: string
    expectedRevision?: string
  },
) {
  const { holder, task } = await resolveContextHolder(input)
  writableDb()
  const item = getContextItem(holder, input.id)
  if (!item) return { holder, task: task?.key ?? null, id: input.id, removed: false }
  await assertContextDropAllowed({ item, task: task ?? undefined })
  const removed = removeLocalContextItem(holder, input.id, input.expectedRevision)
  return { holder, task: task?.key ?? null, id: input.id, removed }
}
