import { docScopeHasProjectSubject } from '../../../../shared/docs.ts'
import type { DocsAudience, DocsDoc, DocsSearchMatch, DocsTreeItem } from './types.ts'

function audienceOf(value: unknown): DocsAudience {
  return value === 'user' ? 'user' : 'technical'
}

function deliveryOf(value: unknown): DocsTreeItem['delivery'] {
  return value === 'inject' || value === 'demand' ? value : undefined
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
    audience: audienceOf(row.audience),
    delivery: deliveryOf(row.delivery),
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
