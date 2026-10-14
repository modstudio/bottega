import {
  type DocArticleSubject,
  type DocAudience,
  type DocAudiences,
  type DocForm,
  type DocScope,
  type DocStatus,
  normalizeDocAudiences,
} from '../../../../shared/docs.ts'
import {
  DOC_AUDIENCE_LABELS,
  DOC_DELIVERY_LABELS,
  DOC_FORM_LABELS,
  DOC_STATUS_LABELS,
} from './filters.ts'
import type { DocsDoc, DocsTreeItem } from './types.ts'

export type DocFieldChange =
  | { field: 'status'; value: Extract<DocStatus, 'draft' | 'current'> }
  | { field: 'parent'; value: DocsTreeItem | null }
  | { field: 'audiences'; value: DocAudiences }
  | { field: 'form'; value: DocForm | null }
  | { field: 'articleSubject'; value: DocArticleSubject | null }
  | { field: 'relatedSubjects'; value: DocArticleSubject[] }
  | { field: 'sourceFiles'; value: string[]; action: 'added' | 'removed'; path: string }
  | { field: 'delivery'; value: 'inject' | 'demand' }

type WriteBase = {
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  body: string
  reason: string
  expectedRevision?: string
}

export type LocalFieldWrite = WriteBase & {
  status?: 'draft' | 'current'
  parentSlug?: string | null
  audiences?: DocAudiences
  form?: DocForm | null
  articleSubject?: string | null
  relatedSubjects?: string[]
  sourceFiles?: string[]
  delivery?: 'inject' | 'demand'
}

export type HostedFieldWrite = WriteBase & {
  spaceId: string
  expectedRevision: string
  status?: 'draft' | 'current'
  parentRecordId?: string | null
  audiences?: DocAudiences
  form?: DocForm | null
  articleSubjectId?: string | null
  relatedSubjectIds?: string[]
  sourceFiles?: string[]
  delivery?: 'inject' | 'demand'
}

/** Same-project, same-scope parents, excluding the document and everything below it. */
export function parentChoices(doc: DocsDoc, items: readonly DocsTreeItem[]): DocsTreeItem[] {
  const descendants = new Set<string>([doc.id])
  let changed = true
  while (changed) {
    changed = false
    for (const item of items) {
      if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) {
        descendants.add(item.id)
        changed = true
      }
    }
  }
  return items.filter(
    (item) =>
      item.scope === doc.scope && item.projectName === doc.projectName && !descendants.has(item.id),
  )
}

function joined(values: readonly string[]): string {
  return [...values].sort((left, right) => left.localeCompare(right)).join(', ')
}

/** The revision reason shown in History for one field change. */
export function fieldChangeReason(change: DocFieldChange): string {
  switch (change.field) {
    case 'status':
      return `Status set to ${DOC_STATUS_LABELS[change.value]}`
    case 'parent':
      return change.value ? `Parent set to ${change.value.title}` : 'Moved to top level'
    case 'audiences':
      return `Audience set to ${joined(change.value.map((value) => DOC_AUDIENCE_LABELS[value]))}`
    case 'form':
      return change.value ? `Type set to ${DOC_FORM_LABELS[change.value]}` : 'Type cleared'
    case 'articleSubject':
      return change.value ? `Subject set to ${change.value.name}` : 'Subject cleared'
    case 'relatedSubjects':
      return change.value.length
        ? `Related subjects set to ${joined(change.value.map(({ name }) => name))}`
        : 'Related subjects cleared'
    case 'sourceFiles':
      return `Source file ${change.action}: ${change.path}`
    case 'delivery':
      return `Delivery set to ${DOC_DELIVERY_LABELS[change.value]}`
  }
}

/**
 * The subjects still free to choose, leaving out those already taken by the other subject field:
 * an article's own subject is never also a related subject.
 */
export function subjectsExcept(
  subjects: readonly DocArticleSubject[],
  taken: readonly DocArticleSubject[],
): DocArticleSubject[] {
  const takenIds = new Set(taken.map(({ id }) => id))
  return subjects.filter(({ id }) => !takenIds.has(id))
}

type LocalFieldPatch = Omit<LocalFieldWrite, keyof WriteBase>
type HostedFieldPatch = Omit<HostedFieldWrite, keyof WriteBase | 'spaceId'>

function localFieldPatch(change: DocFieldChange): LocalFieldPatch {
  switch (change.field) {
    case 'parent':
      return { parentSlug: change.value?.slug ?? null }
    case 'articleSubject':
      return { articleSubject: change.value?.name ?? null }
    case 'relatedSubjects':
      return { relatedSubjects: change.value.map(({ name }) => name) }
    default:
      return sharedFieldPatch(change)
  }
}

function hostedFieldPatch(change: DocFieldChange): HostedFieldPatch {
  switch (change.field) {
    case 'parent':
      return { parentRecordId: change.value?.id ?? null }
    case 'articleSubject':
      return { articleSubjectId: change.value?.id ?? null }
    case 'relatedSubjects':
      return { relatedSubjectIds: change.value.map(({ id }) => id) }
    default:
      return sharedFieldPatch(change)
  }
}

/** Fields both sources address the same way. */
function sharedFieldPatch(
  change: Exclude<DocFieldChange, { field: 'parent' | 'articleSubject' | 'relatedSubjects' }>,
): LocalFieldPatch & HostedFieldPatch {
  switch (change.field) {
    case 'status':
      return { status: change.value }
    case 'audiences':
      return { audiences: change.value }
    case 'form':
      return { form: change.value }
    case 'sourceFiles':
      return { sourceFiles: change.value }
    case 'delivery':
      return { delivery: change.value }
  }
}

/** A one-field write carrying the stored article text and the source's address form. */
export function fieldWriteInput(
  source: 'local',
  doc: DocsDoc,
  stored: { title: string; body: string; revision: string | null },
  change: DocFieldChange,
): LocalFieldWrite
export function fieldWriteInput(
  source: 'hosted',
  doc: DocsDoc & { spaceId: string },
  stored: { title: string; body: string; revision: string },
  change: DocFieldChange,
): HostedFieldWrite
export function fieldWriteInput(
  source: 'local' | 'hosted',
  doc: DocsDoc,
  stored: { title: string; body: string; revision: string | null },
  change: DocFieldChange,
): LocalFieldWrite | HostedFieldWrite {
  const base = {
    scope: doc.scope as DocScope,
    subject: doc.subject,
    slug: doc.slug,
    title: stored.title,
    body: stored.body,
    reason: fieldChangeReason(change),
    ...(stored.revision ? { expectedRevision: stored.revision } : {}),
  }
  return source === 'hosted'
    ? { ...base, spaceId: doc.spaceId!, ...hostedFieldPatch(change) }
    : { ...base, ...localFieldPatch(change) }
}

/** The audiences ticked in a list, in their canonical order; none at all is not a valid choice. */
export function audiencesFrom(values: readonly DocAudience[]): DocAudiences | null {
  return values.length ? normalizeDocAudiences(values) : null
}
