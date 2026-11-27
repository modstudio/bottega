// concern: document-checked-against-service
/** Records the commit an existing article document was checked against. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DocWriteContext } from './doc-article-fields.ts'
import { type Doc, readDocForWrite } from './doc-authoritative-read.ts'
import { docRewritePayload } from './doc-rewrite-payload.ts'
import { setDoc } from './docs.ts'

export async function setDocCheckedAgainst(
  scope: string,
  subject: string | null,
  slug: string,
  commit: string,
  context: DocWriteContext,
  owner: string | null = null,
): Promise<Doc> {
  const target = await readDocForWrite(scope, subject, slug, owner)
  const current = target.doc
  if (!current)
    throw new Error(`no ${scope} doc "${slug}"; use ${PLATFORM_SLUG} doc list --scope ${scope}`)
  return setDoc(
    {
      ...docRewritePayload(current),
      checkedAgainstCommit: commit,
      ...context,
    },
    undefined,
    target,
  )
}
