import {
  type DocArticleSubject,
  type DocAudience,
  type DocAudiences,
  type DocForm,
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
  | { field: 'summary'; value: string | null }

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
    case 'summary':
      return change.value ? 'Summary updated' : 'Summary cleared'
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

/**
 * The project's subjects plus any the article already carries that the catalog does not list (a
 * retired subject, say), so a choice made from the list never drops one the list could not show.
 */
export function withCurrentSubjects(
  catalog: readonly DocArticleSubject[],
  current: readonly DocArticleSubject[],
): DocArticleSubject[] {
  const listed = new Set(catalog.map(({ id }) => id))
  return [...catalog, ...current.filter(({ id }) => !listed.has(id))]
}

/** The audiences ticked in a list, in their canonical order; none at all is not a valid choice. */
export function audiencesFrom(values: readonly DocAudience[]): DocAudiences | null {
  return values.length ? normalizeDocAudiences(values) : null
}
