// concern: context-service
/** Owns context item reads and mutations over the document store. */
import { sessionId } from '../database/db.ts'
import { decodeContextItem, encodeContextItem } from './context-item-codec.ts'
import { contextProfileForHolder } from './context-write-adapter.ts'
import {
  type ContextItemKind,
  contextDropRefusal,
  missingContextKinds,
} from './doc-context-write.ts'
import { getDoc, listDocs, removeDoc, setDoc } from './docs.ts'

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
  if (holder.startsWith('session:') && holder.slice(8) !== sessionId()) {
    throw new Error(
      `context item ${input.id} refused: only owning session ${holder.slice(8)} may write ${holder}`,
    )
  }
  const items = listDocs({ scope: 'context', subject: holder }).map((row) =>
    decodeContextItem(holder, row.slug, row.body),
  )
  const profile = await contextProfileForHolder(holder)
  const refusal = contextDropRefusal(decodeContextItem(holder, doc.slug, doc.body), items, profile)
  if (refusal) throw new Error(refusal)
  await removeDoc('context', holder, input.id, {
    reason: `drop context item ${input.id}`,
    expectedRevision: input.expectedRevision,
  })
  return { holder, id: input.id, removed: true }
}
