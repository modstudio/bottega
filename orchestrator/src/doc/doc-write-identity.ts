// concern: doc-write-identity
/** Composes local document writes with the cached hosted identity. */

import { cachedSignedInRecordUser } from '../record/record-session.ts'
import type { DocWriteContext } from './doc-article-fields.ts'
import { docWriteIdentity } from './doc-revision-store.ts'

export function resolvedDocWriteIdentity(context: DocWriteContext) {
  return docWriteIdentity(context, cachedSignedInRecordUser()?.id)
}
