// concern: document removal
/** Owns the single document removal path and its session-lifecycle-only entry. */
import { collectCanonLintInput as productionCanonLintInput } from '../canon/canon-files.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { storedCanonRemovalRefusal } from './canon-removal.ts'
import type { DocWriteContext } from './doc-article-fields.ts'
import { contextTaskOwner, hostedDocClient } from './doc-hosted-client.ts'
import { getContextItem, listContextItems, removeLocalContextItem } from './context-item-store.ts'
import { hostedContextItemClient } from './context-item-hosted-client.ts'
import type { Doc } from './doc-read-store.ts'
import { assertLocalStoredReferenceWrite } from './doc-reference-write.ts'
import { assertLocalRevisionWrite } from './doc-revision-store.ts'
import { type ContextDropTarget, docWriteProjectName } from './doc-write-allowed.ts'
import { hostedDocWriteIdentity, resolvedDocWriteIdentity } from './doc-write-identity.ts'
import { assertLocalDocRemovalAllowed, localParentRecordId } from './local-doc-tree-service.ts'
import { commitDocRemove, executeLocalDocRemove } from './local-doc-write.ts'

export type DocRemovalContext = DocWriteContext & {
  contextDropTarget?: ContextDropTarget
}

function assertCanonRemovalAllowed(doc: Doc, context: DocWriteContext): void {
  if (doc.scope !== 'canon') return
  const refusal = storedCanonRemovalRefusal(
    doc,
    context.canonTree,
    context.collectCanonLintInput ?? productionCanonLintInput,
  )
  if (refusal) throw new Error(refusal)
}

/** The shared removal body after the caller's context-drop ownership guard. */
export async function removeStoredDoc(
  doc: Doc,
  context: DocRemovalContext,
  identity: ReturnType<typeof resolvedDocWriteIdentity>,
): Promise<boolean> {
  const { scope, subject, owner, slug } = doc
  assertLocalStoredReferenceWrite(doc, context.generator)
  assertLocalRevisionWrite(
    {
      scope,
      subject,
      slug,
      expectedRevision: context.expectedRevision,
      op: 'delete',
      contextDropTarget: context.contextDropTarget,
    },
    doc.revision,
    false,
  )
  if (context.canonRemovalDecision !== 'already-decided-next-set') {
    assertCanonRemovalAllowed(doc, context)
  }
  assertLocalDocRemovalAllowed(doc)
  return applyRecordWriteAuthority({
    local: () => executeLocalDocRemove({ scope, subject, owner, slug, doc, identity, ...context }),
    hosted: async () => {
      const client = await hostedDocClient(
        doc.scope,
        doc.subject,
        contextTaskOwner(context.contextTask),
      )
      let recordId = doc.record_id
      let hostedExpected = context.expectedRevision
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
          ...hostedDocWriteIdentity(identity),
          id: undefined,
          expectedRevision: context.expectedRevision,
          generator: context.generator,
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await client.deleteDoc(recordId, {
        ...hostedDocWriteIdentity(identity),
        expectedRevision: hostedExpected,
        generator: context.generator,
      })
      return commitDocRemove({
        scope,
        subject,
        owner,
        slug,
        identity,
        ...context,
        revisionId: hosted.revisionId,
      })
    },
  })
}

/** Session teardown bypasses only the ordinary context-drop ownership guard. */
export async function removeContextItemForLifecycle(
  holder: string,
  slug: string,
  context: DocWriteContext,
): Promise<boolean> {
  if (!holder.startsWith('session:')) {
    throw new Error('lifecycle context removal requires a session: subject')
  }
  const item = getContextItem(holder, slug)
  if (!item) return false
  return applyRecordWriteAuthority({
    local: () => removeLocalContextItem(holder, slug, context.expectedRevision),
    hosted: async () => {
      const client = await hostedContextItemClient(holder)
      const result = await client.remove(item.recordId, {
        expectedRevision: context.expectedRevision,
      })
      return result.removed ? removeLocalContextItem(holder, slug, item.revision) : false
    },
  })
}

/** Task teardown removes a complete holder without applying single-item required-kind guards. */
export async function removeTaskContextHolder(
  holder: string,
  _context: DocWriteContext,
): Promise<number> {
  if (!holder.startsWith('task:')) throw new Error('task context clear requires a task: subject')
  let removed = 0
  const items = listContextItems(holder)
  for (const item of items) {
    if (
      await applyRecordWriteAuthority({
        local: () => removeLocalContextItem(holder, item.id, item.revision),
        hosted: async () => {
          const client = await hostedContextItemClient(
            holder,
            contextTaskOwner(_context.contextTask),
          )
          const result = await client.remove(item.recordId, { expectedRevision: item.revision })
          return result.removed ? removeLocalContextItem(holder, item.id, item.revision) : false
        },
      })
    )
      removed++
  }
  return removed
}
