// concern: document-checked-against-service
/** Records the commit an existing article document was checked against. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DocWriteContext } from './doc-article-fields.ts'
import { type Doc, readDoc } from './doc-authoritative-read.ts'
import { setDoc } from './docs.ts'

export async function setDocCheckedAgainst(
  scope: string,
  subject: string | null,
  slug: string,
  commit: string,
  context: DocWriteContext,
  owner: string | null = null,
): Promise<Doc> {
  const current = await readDoc(scope, subject, slug, owner)
  if (!current)
    throw new Error(`no ${scope} doc "${slug}"; use ${PLATFORM_SLUG} doc list --scope ${scope}`)
  return setDoc({
    scope: current.scope,
    subject: current.subject,
    owner: current.owner,
    slug: current.slug,
    title: current.title,
    body: current.body,
    delivery: current.delivery,
    audiences: current.audiences,
    parentSlug: current.parent_slug,
    position: current.position,
    featured: current.featured,
    checkedAgainstCommit: commit,
    ...context,
  })
}
