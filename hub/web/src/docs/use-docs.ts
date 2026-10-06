import { useQuery } from '@tanstack/react-query'
import { hostedTrpc, queryClient, trpc } from '@/trpc/client'
import { DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'
import { mapDoc, mapSearchMatch, mapTreeItem } from './map.ts'
import type { DocsAudience, DocsDoc, DocsSearchMatch, DocsSource, DocsTreeItem } from './types.ts'

function isDocScope(value: string): value is DocScope {
  return (DOC_SCOPES as readonly string[]).includes(value)
}

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
  const localScope = selected && isDocScope(selected.scope) ? selected.scope : null
  const local = useQuery({
    ...trpc.doc.read.queryOptions({
      scope: (localScope ?? 'global') as DocScope,
      subject: selected?.subject ?? null,
      slug: selected?.slug ?? '',
    }),
    enabled: source === 'local' && Boolean(selected && localScope),
  })
  const hosted = useQuery({
    ...trpc.record.doc.queryOptions({
      id: selected?.id ?? '00000000-0000-4000-8000-000000000000',
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
  audience: DocsAudience,
  project: string | 'all',
) {
  const trimmed = query.trim()
  const enabled = trimmed.length >= 2
  const subject = project === 'all' ? undefined : project
  const local = useQuery({
    ...trpc.doc.search.queryOptions({ query: trimmed, audience, subject }),
    enabled: source === 'local' && enabled,
  })
  const hosted = useQuery({
    ...trpc.record.docSearch.queryOptions({
      query: trimmed,
      audience,
      subject,
      acrossReadableSpaces: true,
    }),
    enabled: source === 'hosted' && enabled,
  })
  const published = useQuery({
    ...hostedTrpc.publicDocs.search.queryOptions({ query: trimmed }),
    enabled: source === 'public' && enabled,
  })
  const result = source === 'local' ? local : source === 'hosted' ? hosted : published
  const items: DocsSearchMatch[] = (result.data?.items ?? []).map((row) =>
    mapSearchMatch(row as unknown as Record<string, unknown>),
  )
  return { items, isPending: enabled && result.isFetching, error: result.error }
}
