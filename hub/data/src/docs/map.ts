import type { DocsDoc, DocsSearchMatch, DocsTreeItem } from '@bottega/hub-views/docs/types'
import type { DocSnippetHighlight } from '../../../../shared/doc-snippet.ts'
import {
  DOC_FORMS,
  DOC_KINDS,
  DOC_STATUSES,
  type DocArticleSubject,
  type DocAudiences,
  type DocKind,
  type DocStatus,
  docScopeHasProjectSubject,
  normalizeDocAudiences,
} from '../../../../shared/docs.ts'

function audiencesOf(value: unknown): DocAudiences {
  if (!Array.isArray(value)) throw new Error('document audiences must be an array')
  return normalizeDocAudiences(value.map(String))
}
function deliveryOf(value: unknown): DocsTreeItem['delivery'] {
  return value === 'inject' || value === 'demand' ? value : undefined
}
function statusOf(value: unknown): DocStatus {
  return DOC_STATUSES.includes(value as DocStatus) ? (value as DocStatus) : 'current'
}
function kindOf(value: unknown): DocKind {
  if (!DOC_KINDS.includes(value as DocKind)) throw new Error('document kind is required')
  return value as DocKind
}
function formOf(value: unknown): DocsTreeItem['form'] {
  if (value === null) return null
  return DOC_FORMS.includes(value as (typeof DOC_FORMS)[number])
    ? (value as (typeof DOC_FORMS)[number])
    : undefined
}
function articleSubjectOf(value: unknown): DocArticleSubject | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const subject = value as Record<string, unknown>
  if (typeof subject.id !== 'string' || typeof subject.name !== 'string') return undefined
  return { id: subject.id, name: subject.name }
}
function relatedSubjectsOf(value: unknown): DocArticleSubject[] | undefined {
  if (!Array.isArray(value)) return undefined
  const subjects = value.map(articleSubjectOf)
  return subjects.every((subject): subject is DocArticleSubject => Boolean(subject))
    ? subjects
    : undefined
}
function projectNameOf(
  row: Record<string, unknown>,
  scope: string,
  subject: string | null,
): string | undefined {
  if (Object.hasOwn(row, 'projectName')) {
    return typeof row.projectName === 'string' && row.projectName ? row.projectName : undefined
  }
  if (subject && docScopeHasProjectSubject(scope)) return subject
  return undefined
}

export function mapTreeItem(row: Record<string, unknown>): DocsTreeItem {
  const scope = String(row.scope ?? '')
  const subject = row.subject == null ? null : String(row.subject)
  return {
    id: String(row.recordId ?? row.id),
    ...(typeof row.spaceId === 'string' ? { spaceId: row.spaceId } : {}),
    slug: String(row.slug ?? ''),
    title: String(row.title ?? ''),
    parentId:
      (row.parentRecordId ?? row.parentId) == null
        ? null
        : String(row.parentRecordId ?? row.parentId),
    position: typeof row.position === 'number' ? row.position : 0,
    updatedAt: String(row.updatedAt ?? ''),
    scope,
    subject,
    audiences: audiencesOf(row.audiences),
    status: statusOf(row.status),
    kind: kindOf(row.kind),
    form: formOf(row.form),
    replacementSlug: typeof row.replacementSlug === 'string' ? row.replacementSlug : null,
    delivery: deliveryOf(row.delivery),
    summary: typeof row.summary === 'string' ? row.summary : '',
    summarySource: row.summarySource === 'written' ? 'written' : 'derived',
    featured: row.featured === true,
    projectName: projectNameOf(row, scope, subject),
  }
}
export function mapDoc(row: Record<string, unknown>): DocsDoc {
  return {
    ...mapTreeItem(row),
    body: String(row.body ?? ''),
    articleSubject: articleSubjectOf(row.articleSubject),
    relatedSubjects: relatedSubjectsOf(row.relatedSubjects),
    sourceFiles: Array.isArray(row.sourceFiles)
      ? row.sourceFiles.filter((path): path is string => typeof path === 'string')
      : undefined,
    checkedAgainstCommit:
      row.checkedAgainstCommit === null
        ? null
        : typeof row.checkedAgainstCommit === 'string'
          ? row.checkedAgainstCommit
          : undefined,
  }
}
export function mapSearchMatch(row: Record<string, unknown>): DocsSearchMatch {
  return {
    id: String(row.id),
    slug: String(row.slug ?? ''),
    title: String(row.title ?? ''),
    status: statusOf(row.status),
    kind: kindOf(row.kind),
    audiences: audiencesOf(row.audiences),
    snippet: String(row.snippet ?? ''),
    summary: String(row.summary ?? ''),
    summarySource: row.summarySource === 'written' ? 'written' : 'derived',
    spaceName: typeof row.spaceName === 'string' ? row.spaceName : undefined,
    highlights: highlightsOf(row.highlights),
  }
}
function highlightsOf(value: unknown): DocSnippetHighlight[] {
  if (!Array.isArray(value)) return []
  const highlights: DocSnippetHighlight[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const start = (item as { start?: unknown }).start
    const length = (item as { length?: unknown }).length
    if (typeof start === 'number' && typeof length === 'number' && start >= 0 && length >= 0) {
      highlights.push({ start, length })
    }
  }
  return highlights
}
