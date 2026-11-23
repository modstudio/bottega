// concern: hosted-document-unmirrored-result
/** Projects a hosted write result when no local mirror row is available. */

import type { Doc } from './doc-authoritative-read.ts'
import type { TreeWriteFields } from './doc-tree-rules.ts'

type HostedUnmirroredSet = {
  prior: Doc
  write: Pick<Doc, 'title' | 'body'>
  recordId: string
  revisionId: string
  updatedAt: string
  delivery: Doc['delivery']
  kind: Doc['kind']
  tree: TreeWriteFields
  lifecycle: { status: Doc['status']; replacementSlug: string | null }
  article: Pick<
    Doc,
    | 'articleSubject'
    | 'relatedSubjects'
    | 'sourceFiles'
    | 'checkedAgainstCommit'
    | 'summary'
    | 'form'
  >
}

type HostedUnmirroredConsume = {
  prior: Doc
  body: string
  revisionId: string
  alreadyConsumed: boolean
}

export function hostedUnmirroredDoc(input: HostedUnmirroredSet): Doc
export function hostedUnmirroredDoc(
  input: HostedUnmirroredConsume,
): Doc & { already_consumed: boolean }
export function hostedUnmirroredDoc(
  input: HostedUnmirroredSet | HostedUnmirroredConsume,
): Doc & { already_consumed?: boolean } {
  if (!('write' in input)) {
    return {
      ...input.prior,
      body: input.body,
      revision: input.revisionId,
      already_consumed: input.alreadyConsumed,
    }
  }
  return {
    ...input.prior,
    record_id: input.recordId,
    title: input.write.title,
    body: input.write.body,
    delivery: input.delivery,
    audiences: input.tree.audiences,
    parent_record_id: input.tree.parentId,
    parent_slug: input.tree.parentSlug,
    position: input.tree.position,
    featured: input.tree.featured,
    status: input.lifecycle.status,
    kind: input.kind,
    form: input.article.form,
    article_subject_id: input.article.articleSubject?.id ?? null,
    articleSubject: input.article.articleSubject,
    relatedSubjects: input.article.relatedSubjects,
    sourceFiles: input.article.sourceFiles,
    checkedAgainstCommit: input.article.checkedAgainstCommit,
    summary: input.article.summary,
    replacement_slug: input.lifecycle.replacementSlug,
    updated_at: input.updatedAt,
    revision: input.revisionId,
  }
}
