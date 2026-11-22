// concern: authoritative-document-tree-write
/** Derives document tree write fields from the authoritative document store. */

import type { DocAudiences } from '../../../shared/docs.ts'
import { applyRecordReadAuthority } from '../record/record-read-authority.ts'
import { type Doc, readDocs } from './doc-authoritative-read.ts'
import { documentTreeWriteRefusal } from './doc-tree-rules.ts'
import { type LocalDocTreeFields, localDocTreeFields } from './local-doc-tree-service.ts'

type TreeWriteInput = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  audiences?: DocAudiences
  parentSlug?: string | null
  position?: number
  featured?: boolean
}

function hostedTreeFields(
  input: TreeWriteInput,
  prior: Doc | null,
  docs: readonly Doc[],
): LocalDocTreeFields {
  const audiences = input.audiences ?? prior?.audiences ?? ['technical']
  if (input.position !== undefined && !Number.isInteger(input.position))
    throw new Error('--position must be an integer')
  const requestedParentSlug = input.parentSlug
  const parentSlug =
    requestedParentSlug === undefined ? (prior?.parent_slug ?? null) : requestedParentSlug
  const parent = parentSlug ? (docs.find((doc) => doc.slug === parentSlug) ?? null) : null
  const byId = new Map(docs.map((doc) => [doc.record_id, doc]))
  const children = prior
    ? docs.filter((doc) => doc.parent_record_id === prior.record_id).map(({ slug }) => ({ slug }))
    : []
  const ancestorSlugs: string[] = []
  let ancestor = parent
  const seen = new Set<string>()
  while (ancestor && !seen.has(ancestor.record_id)) {
    seen.add(ancestor.record_id)
    ancestorSlugs.push(ancestor.slug)
    ancestor = ancestor.parent_record_id ? (byId.get(ancestor.parent_record_id) ?? null) : null
  }
  const refusal = documentTreeWriteRefusal({
    slug: input.slug,
    scope: input.scope,
    subject: input.subject,
    owner: input.owner ?? null,
    audiences,
    parent,
    requestedParentSlug,
    ancestorSlugs,
    children,
  })
  if (refusal) throw new Error(refusal)
  return {
    audiences,
    parentId: parent?.record_id ?? null,
    parentSlug,
    position: input.position ?? prior?.position ?? 0,
    featured: input.featured ?? prior?.featured ?? false,
  }
}

export function docTreeWriteFields(
  input: TreeWriteInput,
  prior: Doc | null,
): Promise<LocalDocTreeFields> {
  return applyRecordReadAuthority({
    local: () => localDocTreeFields(input, prior),
    hosted: async () =>
      hostedTreeFields(
        input,
        prior,
        await readDocs({ scope: input.scope, subject: input.subject, owner: input.owner ?? null }),
      ),
  })
}
