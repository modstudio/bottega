import {
  DOC_STATUSES,
  type DocAudiences,
  type DocStatus,
  docScopeHasProjectSubject,
  normalizeDocAudiences,
} from '../../../../shared/docs.ts'
import type { DocsDoc, DocsSearchMatch, DocsTreeItem } from './types.ts'

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

/** Map any document-shaped record onto the shared tree item. */
export function mapTreeItem(row: Record<string, unknown>): DocsTreeItem {
  const scope = String(row.scope ?? '')
  const subject = row.subject == null ? null : String(row.subject)
  return {
    id: String(row.id),
    slug: String(row.slug ?? ''),
    title: String(row.title ?? ''),
    parentId: row.parentId == null ? null : String(row.parentId),
    position: typeof row.position === 'number' ? row.position : 0,
    updatedAt: String(row.updatedAt ?? ''),
    scope,
    subject,
    audiences: audiencesOf(row.audiences),
    status: statusOf(row.status),
    replacementSlug: typeof row.replacementSlug === 'string' ? row.replacementSlug : null,
    delivery: deliveryOf(row.delivery),
    summary: typeof row.summary === 'string' ? row.summary : '',
    featured: row.featured === true,
    projectName: projectNameOf(row, scope, subject),
  }
}

export function mapDoc(row: Record<string, unknown>): DocsDoc {
  return { ...mapTreeItem(row), body: String(row.body ?? '') }
}

export function mapSearchMatch(row: Record<string, unknown>): DocsSearchMatch {
  return {
    id: String(row.id),
    slug: String(row.slug ?? ''),
    title: String(row.title ?? ''),
    status: statusOf(row.status),
    audiences: audiencesOf(row.audiences),
    snippet: String(row.snippet ?? ''),
    spaceName: typeof row.spaceName === 'string' ? row.spaceName : undefined,
    matchPosition: typeof row.matchPosition === 'number' ? row.matchPosition : null,
  }
}

export function highlightSnippet(
  snippet: string,
  matchPosition: number | null,
  query: string,
): { before: string; match: string; after: string } {
  const needle = query.trim()
  if (!needle) return { before: snippet, match: '', after: '' }
  const at =
    matchPosition != null && matchPosition >= 0 && matchPosition < snippet.length
      ? matchPosition
      : snippet.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (at < 0) return { before: snippet, match: '', after: '' }
  const length = needle.length
  return {
    before: snippet.slice(0, at),
    match: snippet.slice(at, at + length),
    after: snippet.slice(at + length),
  }
}
