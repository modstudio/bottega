// concern: context-service
/** Owns context item reads and mutations over the document store. */
import type { Database } from 'bun:sqlite'
import { sessionId } from '../database/db.ts'
import { decodeContextItem, encodeContextItem } from './context-item-codec.ts'
import { contextProfileForHolder, resolveContextTask } from './context-write-adapter.ts'
import {
  type ContextItemKind,
  type ContextTaskIdentity,
  missingContextKinds,
} from './doc-context-write.ts'
import { type Doc, listDocsBySubjectPrefixStore, listDocsStore } from './doc-read-store.ts'
import { removeContextItemForLifecycle } from './doc-remove.ts'
import { taskContextHolder } from './doc-subjects.ts'
import { getDoc, removeDoc, setDoc } from './docs.ts'

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
  const items = holderContextItems(holder, listDocsStore({ scope: 'context', subject: holder }))
  return {
    holder,
    task: task?.key ?? null,
    profile,
    items,
    missingRequired: missingContextKinds(items, profile),
  }
}

function holderContextItems(holder: string, docs: readonly Doc[]) {
  return docs.map((doc) => ({
    ...decodeContextItem(holder, doc.slug, doc.body),
    revision: doc.revision,
    updatedAt: doc.updated_at,
  }))
}

export function sessionContextItems(session: string, database: Database) {
  const holder = `session:${session}`
  return holderContextItems(holder, listDocsStore({ scope: 'context', subject: holder }, database))
}

/** Read one task's context items through the document-store owner. */
export function taskContextItems(task: ContextTaskIdentity, database: Database) {
  const holder = taskContextHolder(task.record_id)
  return holderContextItems(holder, listDocsStore({ scope: 'context', subject: holder }, database))
}

export function sessionContextHolders(database: Database) {
  const docs = listDocsBySubjectPrefixStore('context', 'session:', database)
  return [...Map.groupBy(docs, (doc) => doc.subject!)].map(([holder, rows]) => ({
    holder,
    session: holder.slice('session:'.length),
    updatedAt: rows.reduce(
      (latest, row) => (row.updated_at > latest ? row.updated_at : latest),
      rows[0]!.updated_at,
    ),
    items: holderContextItems(holder, rows),
  }))
}

async function dropSessionContextItemForLifecycle(input: {
  session: string
  id: string
  expectedRevision: string
  reason: string
}) {
  const holder = `session:${input.session}`
  const removed = await removeContextItemForLifecycle(holder, input.id, {
    reason: input.reason,
    expectedRevision: input.expectedRevision,
  })
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
    objection?: string
    body: string
    expectedRevision?: string
  },
) {
  const { holder, task } = await resolveContextHolder(input)
  const doc = await setDoc({
    scope: 'context',
    subject: holder,
    slug: input.id,
    title: input.id,
    body: encodeContextItem(input),
    delivery: 'demand',
    reason: `set context item ${input.id}`,
    expectedRevision: input.expectedRevision,
    contextTask: task ?? undefined,
  })
  return {
    task: task?.key ?? null,
    ...decodeContextItem(holder, doc.slug, doc.body),
    revision: doc.revision,
  }
}

export async function dropContextItem(
  input: ContextHolderSelection & {
    id: string
    expectedRevision?: string
  },
) {
  const { holder, task } = await resolveContextHolder(input)
  const doc = getDoc('context', holder, input.id)
  if (!doc) throw new Error(`no context item ${holder}/${input.id}`)
  await removeDoc('context', holder, input.id, {
    reason: `drop context item ${input.id}`,
    expectedRevision: input.expectedRevision,
    contextTask: task ?? undefined,
  })
  return { holder, task: task?.key ?? null, id: input.id, removed: true }
}
