// concern: context-service
/** Owns context item reads and mutations over the document store. */
import type { Database } from 'bun:sqlite'
import { sessionId, writableDb } from '../database/db.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { decodeContextItem, encodeContextItem } from './context-item-codec.ts'
import { contextProfileForHolder } from './context-write-adapter.ts'
import { type ContextItemKind, missingContextKinds } from './doc-context-write.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import { type Doc, listDocsBySubjectPrefixStore, listDocsStore } from './doc-read-store.ts'
import { assertLocalStoredReferenceWrite } from './doc-reference-write.ts'
import { assertLocalRevisionWrite } from './doc-revision-store.ts'
import { docWriteProjectName } from './doc-write-allowed.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'
import { resolvedDocWriteIdentity } from './doc-write-identity.ts'
import { getDoc, removeDoc, setDoc } from './docs.ts'
import { assertLocalDocRemovalAllowed, localParentRecordId } from './local-doc-tree-service.ts'
import { commitDocRemove, executeLocalDocRemove } from './local-doc-write.ts'

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
  const items = holderContextItems(holder, listDocsStore({ scope: 'context', subject: holder }))
  return { holder, profile, items, missingRequired: missingContextKinds(items, profile) }
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
  assertWorkerDocStoreWriteAllowed('dropSessionContextItemForLifecycle')
  writableDb()
  const context = { reason: input.reason, expectedRevision: input.expectedRevision }
  const identity = resolvedDocWriteIdentity(context)
  const doc = getDoc('context', holder, input.id)
  if (!doc) return { holder, id: input.id, removed: false }
  assertLocalStoredReferenceWrite(doc)
  assertLocalRevisionWrite(
    { scope: 'context', subject: holder, slug: input.id, expectedRevision: input.expectedRevision },
    doc.revision,
    false,
  )
  assertLocalDocRemovalAllowed(doc)
  const hostedIdentity = {
    author: identity.author,
    reason: identity.reason,
    sessionId: identity.session,
  }
  const removed = await applyRecordWriteAuthority({
    local: () =>
      executeLocalDocRemove({
        scope: 'context',
        subject: holder,
        owner: null,
        slug: input.id,
        doc,
        identity,
        ...context,
      }),
    hosted: async () => {
      const client = await hostedDocClient(doc.scope, doc.subject)
      let recordId = doc.record_id
      let hostedExpected = input.expectedRevision
      if (!recordId) {
        const created = await client.upsertDoc({
          scope: doc.scope,
          subject: doc.subject,
          owner: doc.owner,
          slug: doc.slug,
          title: doc.title,
          body: doc.body,
          delivery: doc.delivery,
          audiences: doc.audiences,
          parentRecordId: localParentRecordId(doc),
          position: doc.position,
          featured: doc.featured,
          projectName: docWriteProjectName(doc.scope, doc.subject),
          ...hostedIdentity,
          id: undefined,
          expectedRevision: input.expectedRevision,
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await client.deleteDoc(recordId, {
        ...hostedIdentity,
        expectedRevision: hostedExpected,
      })
      return commitDocRemove({
        scope: 'context',
        subject: holder,
        owner: null,
        slug: input.id,
        identity,
        ...context,
        revisionId: hosted.revisionId,
      })
    },
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
