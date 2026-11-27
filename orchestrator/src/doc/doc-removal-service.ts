// concern: document-removal-service
/** Resolves, validates, and removes document write targets. */

import { writableDb } from '../database/db.ts'
import type { DocWriteTarget } from './doc-authoritative-read.ts'
import type { DocRemovalContext } from './doc-remove.ts'
import { removeStoredDoc, validateStoredDocRemoval } from './doc-remove.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'
import { resolvedDocWriteIdentity } from './doc-write-identity.ts'

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
