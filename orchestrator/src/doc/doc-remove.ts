// concern: document removal
/** Owns the single document removal path. */
import { collectCanonLintInput as productionCanonLintInput } from '../canon/canon-files.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { storedCanonRemovalRefusal } from './canon-removal.ts'
import type { DocWriteContext } from './doc-article-fields.ts'
import type { DocWriteTarget } from './doc-authoritative-read.ts'
import { contextTaskOwner, hostedDocClient } from './doc-hosted-client.ts'
import { type Doc, getDocStore } from './doc-read-store.ts'
import { assertLocalStoredReferenceWrite } from './doc-reference-write.ts'
import { assertLocalRevisionWrite } from './doc-revision-store.ts'
import { docWriteProjectName } from './doc-write-allowed.ts'
import { hostedDocWriteIdentity, type resolvedDocWriteIdentity } from './doc-write-identity.ts'
import { assertLocalDocRemovalAllowed, localParentRecordId } from './local-doc-tree-service.ts'
import { commitDocRemove, executeLocalDocRemove } from './local-doc-write.ts'

export type DocRemovalContext = DocWriteContext

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
  target: DocWriteTarget,
  context: DocRemovalContext,
  identity: ReturnType<typeof resolvedDocWriteIdentity>,
): Promise<boolean> {
  const { doc } = target
  if (!doc) throw new Error('cannot remove an absent document')
  const { scope, subject, owner, slug } = doc
  assertLocalStoredReferenceWrite(doc, context.generator)
  assertLocalRevisionWrite(
    {
      scope,
      subject,
      slug,
      expectedRevision: context.expectedRevision,
      op: 'delete',
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
      if (!target.spaceId)
        throw new Error(`refusing hosted write for ${scope}/${subject ?? '_'}/${slug}: the read target names no space`)
      const client = await hostedDocClient(doc.scope, doc.subject, {
        owner: contextTaskOwner(context.contextTask),
        destinationSpaceId: target.spaceId,
      })
      let recordId = doc.record_id
      let hostedExpected = context.expectedRevision ?? doc.revision ?? undefined
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
      if (!getDocStore(scope, subject, slug, owner)) return true
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
