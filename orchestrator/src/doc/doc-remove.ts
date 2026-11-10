// concern: document removal
/** Owns the single document removal path and its session-lifecycle-only entry. */
import { collectCanonLintInput as productionCanonLintInput } from '../canon/canon-files.ts'
import { writableDb } from '../database/db.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { storedCanonRemovalRefusal } from './canon-removal.ts'
import type { DocWriteContext } from './doc-article-fields.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import { type Doc, getDocStore } from './doc-read-store.ts'
import { assertLocalStoredReferenceWrite } from './doc-reference-write.ts'
import { assertLocalRevisionWrite } from './doc-revision-store.ts'
import { type ContextDropTarget, docWriteProjectName } from './doc-write-allowed.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'
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
        context.contextTask ? { kind: 'task', projectName: context.contextTask.project } : undefined,
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

/** Session teardown skips only the ordinary context-drop ownership guard. */
export async function removeContextItemForLifecycle(
  holder: string,
  slug: string,
  context: DocWriteContext,
): Promise<boolean> {
  if (!holder.startsWith('session:')) {
    throw new Error('lifecycle context removal requires a session: subject')
  }
  assertWorkerDocStoreWriteAllowed('removeContextItemForLifecycle')
  writableDb()
  const identity = resolvedDocWriteIdentity(context)
  const doc = getDocStore('context', holder, slug)
  if (!doc) return false
  return removeStoredDoc(doc, context, identity)
}
