// concern: orch-doc-argv
/** Builds the orchestrator document command argv hub uses; it does not spawn. */

import type { DocAudience, DocAudiences, DocForm, DocKind, DocStatus } from '../../shared/docs.ts'

export type DocSubjects = {
  project: string[]
  stack: string[]
  agent: string[]
  job: string[]
}

export type DocListFilters = {
  scope?: string
  subject?: string | null
  audience?: DocAudience
  status?: DocStatus
  kind?: DocKind
  match?: string
  bodyMatch?: string
}

export type DocSetInput = {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  reason: string
  delivery?: 'inject' | 'demand'
  audiences?: DocAudiences
  status?: DocStatus
  kind?: DocKind
  replacementSlug?: string | null
  parentSlug?: string | null
  form?: DocForm | null
  articleSubject?: string | null
  relatedSubjects?: string[]
  sourceFiles?: string[]
  position?: number
  expectedRevision?: string
}

export type DocRevisionMetadata = {
  record_id: string
  number: number
  op: 'create' | 'set' | 'consume' | 'delete' | 'restore' | 'import' | 'backfill'
  author: string
  authorName?: string | null
  reason: string
  at: string
  bytes: number
  status?: DocStatus
  kind?: DocKind
  replacement_slug?: string | null
}

export type DocArgvInput = {
  scope?: string
  subject?: string | null
  slug?: string
  title?: string
  body?: string
  reason?: string
  delivery?: 'inject' | 'demand'
  audience?: DocAudience
  audiences?: DocAudiences
  status?: DocStatus
  kind?: DocKind
  replacementSlug?: string | null
  match?: string
  bodyMatch?: string
  parentSlug?: string | null
  form?: DocForm | null
  articleSubject?: string | null
  relatedSubjects?: string[]
  sourceFiles?: string[]
  position?: number
  expectedRevision?: string
  user?: boolean
}

export type DocOp = 'list' | 'get' | 'set' | 'remove' | 'history' | 'subjects'

export type DocReorderInput = {
  scope: string
  subject: string | null
  parentRecordId: string | null
  orderedRecordIds: string[]
}

export function docReorderArgv(input: DocReorderInput): string[] {
  return [
    'doc',
    'reorder',
    ...docAddressFlags(input),
    ...(input.parentRecordId ? ['--parent', input.parentRecordId] : []),
    ...input.orderedRecordIds.flatMap((id) => ['--slug', id]),
    '--json',
  ]
}

function subjectFlags(subject: string | null | undefined): string[] {
  return subject ? ['--subject', subject] : []
}

function docAddressFlags(input: DocArgvInput): string[] {
  return [
    ...(input.scope ? ['--scope', input.scope] : []),
    ...(input.user ? ['--user'] : subjectFlags(input.subject)),
  ]
}

function nullableDocFlag(value: string | null | undefined, flag: string, clearFlag: string) {
  if (value === null) return [clearFlag]
  return value ? [flag, value] : []
}

function docListFlags(values: string[] | undefined, flag: string, clearFlag: string) {
  if (values?.length === 0) return [clearFlag]
  return values?.flatMap((value) => [flag, value]) ?? []
}

function docSetFlags(input: DocArgvInput): string[] {
  return [
    ...(input.delivery ? ['--delivery', input.delivery] : []),
    ...(input.audiences ? ['--audience', input.audiences.join(',')] : []),
    ...(input.status ? ['--status', input.status] : []),
    ...(input.kind ? ['--kind', input.kind] : []),
    ...(input.replacementSlug ? ['--replacement', input.replacementSlug] : []),
    ...nullableDocFlag(input.parentSlug, '--parent', '--no-parent'),
    ...nullableDocFlag(input.form, '--form', '--no-form'),
    ...nullableDocFlag(input.articleSubject, '--article-subject', '--no-article-subject'),
    ...docListFlags(input.relatedSubjects, '--related-subject', '--no-related-subjects'),
    ...docListFlags(input.sourceFiles, '--source-file', '--no-source-files'),
    ...(input.position !== undefined ? ['--position', String(input.position)] : []),
    ...(input.expectedRevision ? ['--expect', input.expectedRevision] : []),
  ]
}

export function docArgv(op: DocOp, input: DocArgvInput = {}): string[] {
  switch (op) {
    case 'list':
      return [
        'doc',
        'list',
        ...docAddressFlags(input),
        ...(input.audience ? ['--audience', input.audience] : []),
        ...(input.status ? ['--status', input.status] : []),
        ...(input.kind ? ['--kind', input.kind] : []),
        ...(input.match !== undefined ? ['--match', input.match] : []),
        ...(input.bodyMatch !== undefined ? ['--body-match', input.bodyMatch] : []),
        '--json',
      ]
    case 'get':
      return [
        'doc',
        'show',
        input.slug!,
        ...docAddressFlags(input),
        ...(input.audience ? ['--audience', input.audience] : []),
        '--json',
      ]
    case 'set':
      return [
        'doc',
        'set',
        input.slug!,
        ...docAddressFlags(input),
        '--title',
        input.title!,
        '--reason',
        input.reason!,
        ...docSetFlags(input),
        '--json',
      ]
    case 'remove':
      return [
        'doc',
        'rm',
        input.slug!,
        ...docAddressFlags(input),
        '--reason',
        input.reason!,
        ...(input.expectedRevision ? ['--expect', input.expectedRevision] : []),
        '--json',
      ]
    case 'history':
      return ['doc', 'history', input.scope!, input.subject ?? '-', input.slug!, '--json']
    case 'subjects':
      return ['doc', 'subjects', '--json']
  }
}
