// concern: authoritative-document-tree-write
/** Derives document tree write fields from the authoritative document store. */

import { applyRecordReadAuthority } from '../record/record-read-authority.ts'
import { type Doc, readDocs } from './doc-authoritative-read.ts'
import { deriveDocumentTreeWriteFields, type TreeWriteInput } from './doc-tree-rules.ts'
import { type LocalDocTreeFields, localDocTreeFields } from './local-doc-tree-service.ts'

function hostedTreeFields(
  input: TreeWriteInput,
  prior: Doc | null,
  docs: readonly Doc[],
): LocalDocTreeFields {
  const parentSlug =
    input.parentSlug === undefined ? (prior?.parent_slug ?? null) : input.parentSlug
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
  return deriveDocumentTreeWriteFields(input, prior, {
    parent,
    ancestorSlugs,
    children,
  })
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
