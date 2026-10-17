import type {
  DocArticleSubject,
  DocAudiences,
  DocForm,
  DocScope,
  DocStatus,
} from '../../../../shared/docs.ts'
import type { DataTreeItem, StoredDocument } from './use-docs.ts'

export type DataDocFieldChange =
  | { field: 'status'; value: Extract<DocStatus, 'draft' | 'current'> }
  | { field: 'parent'; value: (DataTreeItem & { title: string }) | null }
  | { field: 'audiences'; value: DocAudiences }
  | { field: 'form'; value: DocForm | null }
  | { field: 'articleSubject'; value: DocArticleSubject | null }
  | { field: 'relatedSubjects'; value: DocArticleSubject[] }
  | { field: 'sourceFiles'; value: string[]; action: 'added' | 'removed'; path: string }
  | { field: 'delivery'; value: 'inject' | 'demand' }
  | { field: 'summary'; value: string | null }

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
  summary?: string | null
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
  summary?: string | null
}

type LocalFieldPatch = Omit<LocalFieldWrite, keyof WriteBase>
type HostedFieldPatch = Omit<HostedFieldWrite, keyof WriteBase | 'spaceId'>

function sharedFieldPatch(
  change: Exclude<DataDocFieldChange, { field: 'parent' | 'articleSubject' | 'relatedSubjects' }>,
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
    case 'summary':
      return { summary: change.value }
  }
}

function localFieldPatch(change: DataDocFieldChange): LocalFieldPatch {
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

function hostedFieldPatch(change: DataDocFieldChange): HostedFieldPatch {
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

/** A one-field write carrying the stored article text and the adapter's address form. */
export function fieldWriteInput(
  source: 'local' | 'hosted',
  doc: DataTreeItem,
  stored: StoredDocument,
  change: DataDocFieldChange,
  reason: string,
): LocalFieldWrite | HostedFieldWrite {
  const base = {
    scope: doc.scope as DocScope,
    subject: doc.subject,
    slug: doc.slug,
    title: stored.title,
    body: stored.body,
    reason,
    ...(stored.revision ? { expectedRevision: stored.revision } : {}),
  }
  return source === 'hosted'
    ? {
        ...base,
        spaceId: doc.spaceId!,
        expectedRevision: stored.revision!,
        ...hostedFieldPatch(change),
      }
    : { ...base, ...localFieldPatch(change) }
}
