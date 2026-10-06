import type { DocsAudience, DocsDoc, DocsSearchMatch, DocsTreeItem } from './types.ts'

function audienceOf(value: unknown): DocsAudience {
  return value === 'user' ? 'user' : 'technical'
}

function deliveryOf(value: unknown): DocsTreeItem['delivery'] {
  return value === 'inject' || value === 'demand' ? value : undefined
}

/** Map any document-shaped record onto the shared tree item. */
export function mapTreeItem(row: Record<string, unknown>): DocsTreeItem {
  return {
    id: String(row.id),
    slug: String(row.slug ?? ''),
    title: String(row.title ?? ''),
    parentId: row.parentId == null ? null : String(row.parentId),
    position: typeof row.position === 'number' ? row.position : 0,
    updatedAt: String(row.updatedAt ?? ''),
    scope: String(row.scope ?? ''),
    subject: row.subject == null ? null : String(row.subject),
    audience: audienceOf(row.audience),
    delivery: deliveryOf(row.delivery),
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
