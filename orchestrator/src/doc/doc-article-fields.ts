/** Resolves and validates article fields for a local document write. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type DocAudiences,
  type DocForm,
  type DocKind,
  type DocStatus,
  normalizeDocCheckedAgainstCommit,
  normalizeDocSourceFiles,
} from '../../../shared/docs.ts'
import type { CanonLintInputCollector } from '../canon/canon-files.ts'
import type { CanonRow } from '../canon/canon-hydrate.ts'
import { resolveSubject } from '../subject/subjects.ts'
import type { DocGenerator } from './doc-generator.ts'
import type { Doc, DocRevision } from './doc-read-store.ts'
import { articleFieldRefusal, type CanonWriteTree } from './doc-write-allowed.ts'

export type DocWriteContext = {
  author?: string
  reason: string
  forceInject?: string
  canonSet?: CanonRow[]
  allowCanonBootstrap?: boolean
  canonRemovalDecision?: 'already-decided-next-set'
  expectedRevision?: string
  canonTree?: CanonWriteTree
  collectCanonLintInput?: CanonLintInputCollector
  generator?: DocGenerator
}

export type DocWriteInput = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  title: string
  body: string
  delivery?: 'inject' | 'demand'
  audiences?: DocAudiences
  parentSlug?: string | null
  position?: number
  featured?: boolean
  status?: DocStatus
  kind?: DocKind
  form?: DocForm | null
  articleSubject?: string | null
  relatedSubjects?: string[]
  sourceFiles?: string[]
  checkedAgainstCommit?: string | null
  replacementSlug?: string | null
} & DocWriteContext

type ArticleFieldInput = {
  scope?: string
  audiences?: unknown
  form?: DocForm | null
  articleSubject?: string | null
  relatedSubjects?: string[]
  sourceFiles?: string[]
  checkedAgainstCommit?: string | null
}

export function resolveLocalDocArticleFields(
  input: ArticleFieldInput & { scope: string },
  prior: Doc | null,
  kind: DocKind,
  projectName: string | null,
) {
  const existingIds = new Set([
    ...(prior?.articleSubject ? [prior.articleSubject.id] : []),
    ...(prior?.relatedSubjects.map(({ id }) => id) ?? []),
  ])
  const resolveAttachment = (reference: string) => {
    if (!projectName) throw new Error('article fields may be set only on project documents')
    const row = resolveSubject(projectName, reference)
    if (row.retiredAt && !existingIds.has(row.id)) {
      throw new Error(
        `subject "${reference}" is retired; cleared by: ${PLATFORM_SLUG} doc subject list ${projectName}`,
      )
    }
    return { id: row.id, name: row.name }
  }
  const articleSubject =
    input.articleSubject === undefined
      ? (prior?.articleSubject ?? null)
      : input.articleSubject === null
        ? null
        : resolveAttachment(input.articleSubject)
  const relatedSubjects =
    input.relatedSubjects === undefined
      ? (prior?.relatedSubjects ?? [])
      : input.relatedSubjects.map(resolveAttachment)
  const form = input.form === undefined ? (prior?.form ?? null) : input.form
  const sourceFiles =
    input.sourceFiles === undefined
      ? (prior?.sourceFiles ?? [])
      : normalizeDocSourceFiles(input.sourceFiles)
  const checkedAgainstCommit =
    input.checkedAgainstCommit === undefined
      ? (prior?.checkedAgainstCommit ?? null)
      : input.checkedAgainstCommit === null
        ? null
        : normalizeDocCheckedAgainstCommit(input.checkedAgainstCommit)
  const refusal = articleFieldRefusal({
    scope: input.scope,
    kind,
    form,
    ownSubjectId: articleSubject?.id ?? null,
    relatedSubjectIds: relatedSubjects.map(({ id }) => id),
    sourceFiles,
    checkedAgainstCommit,
  })
  if (refusal) throw new Error(refusal)
  if (!prior && kind === 'article' && input.audiences === undefined) {
    throw new Error(
      'creating an article requires audiences; pass --audience on the CLI or audiences through MCP/API',
    )
  }
  return { form, articleSubject, relatedSubjects, sourceFiles, checkedAgainstCommit }
}

export function hostedArticleWriteFields(
  input: ArticleFieldInput,
  fields: ReturnType<typeof resolveLocalDocArticleFields>,
) {
  return {
    ...(input.form !== undefined ? { form: fields.form } : {}),
    ...(input.articleSubject !== undefined
      ? { articleSubjectId: fields.articleSubject?.id ?? null }
      : {}),
    ...(input.relatedSubjects !== undefined
      ? { relatedSubjectIds: fields.relatedSubjects.map(({ id }) => id) }
      : {}),
    ...(input.sourceFiles !== undefined ? { sourceFiles: fields.sourceFiles } : {}),
    ...(input.checkedAgainstCommit !== undefined
      ? { checkedAgainstCommit: fields.checkedAgainstCommit }
      : {}),
  }
}

export function localRevisionArticleFields(revision: DocRevision) {
  return {
    form: revision.form,
    articleSubject: revision.articleSubject,
    relatedSubjects: revision.relatedSubjects,
    sourceFiles: revision.sourceFiles,
    checkedAgainstCommit: revision.checkedAgainstCommit,
  }
}

export function localRevisionArticleReferences(revision: DocRevision) {
  return {
    form: revision.form,
    articleSubject: revision.articleSubject?.id ?? null,
    relatedSubjects: revision.relatedSubjects.map(({ id }) => id),
    sourceFiles: revision.sourceFiles,
    checkedAgainstCommit: revision.checkedAgainstCommit,
  }
}
