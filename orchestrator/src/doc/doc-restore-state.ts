// concern: doc-restore-state
/** Reads and validates the local state a document revision restore will replace. */

import type { DocRevision } from './doc-read-store.ts'
import { getDocStore } from './doc-read-store.ts'
import { assertLocalReferenceRestore } from './doc-reference-write.ts'
import { currentDocRevision } from './doc-revision-store.ts'

export function referenceRestoreState(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null,
  revision: DocRevision,
) {
  const expectedCurrent = currentDocRevision(scope, subject, slug, owner)
  const current = getDocStore(scope, subject, slug, owner)
  assertLocalReferenceRestore(current, revision)
  return [expectedCurrent, current] as const
}
