import { useQuery } from '@tanstack/react-query'
import { hostedTrpc, queryClient, trpc } from '@/trpc/client'
import type { DocScope } from '../../../../shared/docs.ts'
import { mapDoc, mapSearchMatch, mapTreeItem } from './map.ts'
import { isScope } from './scope.ts'
import { docsSearchInputs } from './search-input.ts'
import type { DocsAudience, DocsDoc, DocsSearchMatch, DocsSource, DocsTreeItem } from './types.ts'

async function loadHostedTree(): Promise<DocsTreeItem[]> {
  const items: DocsTreeItem[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await queryClient.fetchQuery(
      trpc.record.docs.queryOptions({
        limit: 100,
        cursor,
        acrossReadableSpaces: true,
      }),
    )
    for (const row of page.items) items.push(mapTreeItem(row as unknown as Record<string, unknown>))
    if (!page.nextCursor) return items
    cursor = page.nextCursor
  }
}

export function useDocsTree(source: DocsSource) {
  const local = useQuery({ ...trpc.doc.tree.queryOptions({}), enabled: source === 'local' })
  const hosted = useQuery({
    queryKey: ['docs-adapter', 'hosted-tree'],
    queryFn: loadHostedTree,
    enabled: source === 'hosted',
  })
  const published = useQuery({
    ...hostedTrpc.publicDocs.tree.queryOptions(),
    enabled: source === 'public',
  })
  if (source === 'hosted') {
    return { items: hosted.data ?? [], isPending: hosted.isPending, error: hosted.error }
  }
  const result = source === 'public' ? published : local
  const items = (result.data?.items ?? []).map((row) =>
    mapTreeItem(row as unknown as Record<string, unknown>),
  )
  return { items, isPending: result.isPending, error: result.error }
}

export function useDocsDocument(
  source: DocsSource,
  selected: DocsTreeItem | null,
  audience: DocsAudience | null,
) {
  const localScope = selected && isScope(selected.scope) ? selected.scope : null
  const local = useQuery({
    ...trpc.doc.read.queryOptions({
      scope: (localScope ?? 'global') as DocScope,
      subject: selected?.subject ?? null,
      slug: selected?.slug ?? '',
      audience: audience ?? undefined,
    }),
    enabled: source === 'local' && Boolean(selected && localScope),
  })
  const hosted = useQuery({
    ...trpc.record.doc.queryOptions({
      id: selected?.id ?? '00000000-0000-4000-8000-000000000000',
      audience: audience ?? undefined,
    }),
    enabled: source === 'hosted' && Boolean(selected?.id),
  })
  const published = useQuery({
    ...hostedTrpc.publicDocs.get.queryOptions({
      id: selected?.id ?? '00000000-0000-4000-8000-000000000000',
    }),
    enabled: source === 'public' && Boolean(selected?.id),
  })
  const result = source === 'local' ? local : source === 'hosted' ? hosted : published
  const document: DocsDoc | null = result.data
    ? mapDoc(result.data as unknown as Record<string, unknown>)
    : null
  return { document, isPending: Boolean(selected) && result.isPending, error: result.error }
}

export function useDocsSearch(
  source: DocsSource,
  query: string,
  audience: DocsAudience | null,
  subject: string | undefined,
  includeDrafts: boolean,
  includeWorking: boolean,
) {
  const trimmed = query.trim()
  const enabled = trimmed.length >= 2
  const input = docsSearchInputs(trimmed, audience, subject, includeDrafts, includeWorking)
  const local = useQuery({
    ...trpc.doc.search.queryOptions(input.local),
    enabled: source === 'local' && enabled,
  })
  const hosted = useQuery({
    ...trpc.record.docSearch.queryOptions(input.hosted),
    enabled: source === 'hosted' && enabled,
  })
  const published = useQuery({
    ...hostedTrpc.publicDocs.search.queryOptions(input.public),
    enabled: source === 'public' && enabled,
  })
  const result = source === 'local' ? local : source === 'hosted' ? hosted : published
  const items: DocsSearchMatch[] = (result.data?.items ?? []).map((row) =>
    mapSearchMatch(row as unknown as Record<string, unknown>),
  )
  return { items, isPending: enabled && result.isFetching, error: result.error }
}

export type StoredDocument = { title: string; body: string; revision: string | null }

/** The unprojected document a write replaces; fetched only while `enabled`. */
export function useStoredDocument(
  doc: DocsDoc | null,
  source: DocsSource,
  enabled: boolean,
): StoredDocument | undefined {
  const scoped = Boolean(doc && isScope(doc.scope))
  const localDoc = useQuery({
    ...trpc.doc.get.queryOptions({
      scope: (doc && isScope(doc.scope) ? doc.scope : 'global') as DocScope,
      subject: doc?.subject ?? null,
      slug: doc?.slug ?? '',
    }),
    enabled: enabled && source === 'local' && scoped,
  })
  const hostedDoc = useQuery({
    ...trpc.record.doc.queryOptions({
      id: doc?.id ?? '00000000-0000-4000-8000-000000000000',
    }),
    enabled: enabled && source === 'hosted' && Boolean(doc?.id),
  })
  const hostedRevisions = useQuery({
    ...trpc.record.docRevisions.queryOptions({
      id: doc?.id ?? '00000000-0000-4000-8000-000000000000',
    }),
    enabled: enabled && source === 'hosted' && Boolean(doc?.id),
  })
  if (source === 'hosted') {
    const revision = hostedRevisions.data?.items[0]?.id
    if (!hostedDoc.data || !revision) return undefined
    return { title: hostedDoc.data.title, body: hostedDoc.data.body, revision }
  }
  if (source !== 'local' || !localDoc.data) return undefined
  return {
    title: localDoc.data.title,
    body: localDoc.data.body,
    revision: localDoc.data.revision,
  }
}
