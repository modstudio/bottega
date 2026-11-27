// concern: document-removal-service
/** Resolves, validates, and removes document write targets. */

import { DOC_SCOPES, type DocScope } from '../../../shared/docs.ts'
import { writableDb } from '../database/db.ts'
import type { DocWriteSpace, DocWriteTarget } from './doc-authoritative-read.ts'
import { readDocForWrite } from './doc-authoritative-read.ts'
import type { DocRemovalContext } from './doc-remove.ts'
import { removeStoredDoc, validateStoredDocRemoval } from './doc-remove.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'
import { resolvedDocWriteIdentity } from './doc-write-identity.ts'
import { docWriteMissRefusal } from './doc-write-miss.ts'

export async function removeDoc(
  scope: string,
  subject: string | null | undefined,
  slug: string,
  context: DocRemovalContext,
  owner: string | null = null,
  selectedSpace?: DocWriteSpace,
): Promise<boolean> {
  assertWorkerDocStoreWriteAllowed('removeDoc')
  writableDb()
  if (!DOC_SCOPES.includes(scope as DocScope))
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  const identity = resolvedDocWriteIdentity(context)
  const target = await readDocForWrite(scope, subject, slug, owner, selectedSpace)
  if (!target.doc) throw new Error(docWriteMissRefusal(scope, subject, slug, owner, selectedSpace))
  return removeStoredDoc(target, context, identity)
}

export async function removeReadDoc(
  target: DocWriteTarget,
  context: DocRemovalContext,
): Promise<boolean> {
  assertWorkerDocStoreWriteAllowed('removeReadDoc')
  writableDb()
  if (!target.doc) throw new Error('cannot remove an absent document')
  return removeStoredDoc(target, context, resolvedDocWriteIdentity(context))
}

export function validateReadDocRemoval(target: DocWriteTarget, context: DocRemovalContext): void {
  assertWorkerDocStoreWriteAllowed('validateReadDocRemoval')
  writableDb()
  resolvedDocWriteIdentity(context)
  validateStoredDocRemoval(target, context)
}
