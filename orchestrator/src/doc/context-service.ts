// concern: context-service
/** Owns context item reads and mutations over the document store. */
import type { Database } from 'bun:sqlite'
import { sessionId } from '../database/db.ts'
import { decodeContextItem, encodeContextItem } from './context-item-codec.ts'
import { contextProfileForHolder } from './context-write-adapter.ts'
import { type ContextItemKind, missingContextKinds } from './doc-context-write.ts'
import { listDocsBySubjectPrefixStore } from './doc-read-store.ts'
import { getDoc, listDocs, removeContextDocForLifecycle, removeDoc, setDoc } from './docs.ts'

export type ContextHolderSelection = { task?: string; session?: string }

function contextHolder(selection: ContextHolderSelection): string {
  if (selection.task && selection.session) throw new Error('use --task or --session, not both')
  if (selection.task) return `task:${selection.task.toUpperCase()}`
  const owner = selection.session ?? sessionId()
  if (!owner) throw new Error('no caller session; pass --task KEY or --session ID')
  return `session:${owner}`
}

export async function getContext(selection: ContextHolderSelection) {
  const holder = contextHolder(selection)
  const profile = await contextProfileForHolder(holder)
  const items = listDocs({ scope: 'context', subject: holder }).map((doc) => ({
    ...decodeContextItem(holder, doc.slug, doc.body),
    revision: doc.revision,
  }))
  return { holder, profile, items, missingRequired: missingContextKinds(items, profile) }
}

export function sessionContextItems(session: string, database?: Database) {
  const holder = `session:${session}`
  const docs = database
    ? listDocsBySubjectPrefixStore('context', holder, database).filter(
        (doc) => doc.subject === holder,
      )
    : listDocs({ scope: 'context', subject: holder })
  return docs.map((doc) => ({
    ...decodeContextItem(holder, doc.slug, doc.body),
    revision: doc.revision,
    updatedAt: doc.updated_at,
  }))
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
    items: rows.map((doc) => ({
      ...decodeContextItem(holder, doc.slug, doc.body),
      revision: doc.revision,
      updatedAt: doc.updated_at,
    })),
  }))
}

export async function dropSessionContextItemForLifecycle(input: {
  session: string
  id: string
  expectedRevision?: string
  reason: string
}) {
  const holder = `session:${input.session}`
  const removed = await removeContextDocForLifecycle(holder, input.id, {
    reason: input.reason,
    expectedRevision: input.expectedRevision,
  })
  return { holder, id: input.id, removed }
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
  const holder = contextHolder(input)
  const doc = await setDoc({
    scope: 'context',
    subject: holder,
    slug: input.id,
    title: input.id,
    body: encodeContextItem(input),
    delivery: 'demand',
    reason: `set context item ${input.id}`,
    expectedRevision: input.expectedRevision,
  })
  return { ...decodeContextItem(holder, doc.slug, doc.body), revision: doc.revision }
}

export async function dropContextItem(
  input: ContextHolderSelection & {
    id: string
    expectedRevision?: string
  },
) {
  const holder = contextHolder(input)
  const doc = getDoc('context', holder, input.id)
  if (!doc) throw new Error(`no context item ${holder}/${input.id}`)
  await removeDoc('context', holder, input.id, {
    reason: `drop context item ${input.id}`,
    expectedRevision: input.expectedRevision,
  })
  return { holder, id: input.id, removed: true }
}
