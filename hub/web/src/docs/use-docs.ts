import { keepPreviousData, useQuery } from '@tanstack/react-query'
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

export function useDocsDocument(source: DocsSource, selected: DocsTreeItem | null) {
  const localScope = selected && isScope(selected.scope) ? selected.scope : null
  const local = useQuery({
    ...trpc.doc.read.queryOptions({
      scope: (localScope ?? 'global') as DocScope,
      subject: selected?.subject ?? null,
      slug: selected?.slug ?? '',
    }),
    enabled: source === 'local' && Boolean(selected && localScope),
    placeholderData: keepPreviousData,
  })
  const hosted = useQuery({
    ...trpc.record.doc.queryOptions({
      id: selected?.id ?? '00000000-0000-4000-8000-000000000000',
    }),
    enabled: source === 'hosted' && Boolean(selected?.id),
    placeholderData: keepPreviousData,
  })
  const published = useQuery({
    ...hostedTrpc.publicDocs.get.queryOptions({
      id: selected?.id ?? '00000000-0000-4000-8000-000000000000',
    }),
    enabled: source === 'public' && Boolean(selected?.id),
    placeholderData: keepPreviousData,
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
  audience: DocsAudience,
  subject: string | undefined,
  includeDrafts: boolean,
) {
  const trimmed = query.trim()
  const enabled = trimmed.length >= 2
  const input = docsSearchInputs(trimmed, audience, subject, includeDrafts)
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
