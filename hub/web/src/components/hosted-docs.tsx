import { useQuery } from '@tanstack/react-query'
import { Outlet, useNavigate } from '@tanstack/react-router'
import type { inferRouterOutputs } from '@trpc/server'
import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/button'
import { Collection, type CollectionColumn } from '@/components/collection'
import { PageHeader } from '@/components/design-system'
import { compactBytes, relativeTime } from '@/lib/format'
import { trpc } from '@/trpc/client'
import type { AppRouter } from '../../../src/trpc/router.ts'

type Doc = inferRouterOutputs<AppRouter>['record']['docs']['items'][number]

export function HostedDocs() {
  return (
    <>
      <HostedDocsList />
      <Outlet />
    </>
  )
}

function HostedDocsList() {
  const navigate = useNavigate()
  const [pages, setPages] = useState<Doc[][]>([])
  const [cursor, setCursor] = useState<string>()
  const [search, setSearch] = useState('')
  const query = useQuery(trpc.record.docs.queryOptions({ limit: 100, cursor }))
  const applied = query.data
  const all = applied
    ? cursor
      ? [...pages.flat(), ...applied.items]
      : applied.items
    : pages.flat()
  const rows = useMemo(() => {
    const text = search.trim().toLowerCase()
    return text ? all.filter((doc) => `${doc.slug} ${doc.title}`.toLowerCase().includes(text)) : all
  }, [all, search])
  const columns: CollectionColumn<Doc>[] = [
    { id: 'scope', label: 'Scope', render: (doc) => doc.scope },
    { id: 'subject', label: 'Subject', render: (doc) => doc.subject ?? '-' },
    { id: 'slug', label: 'Slug', render: (doc) => <strong>{doc.slug}</strong> },
    { id: 'title', label: 'Title', render: (doc) => doc.title },
    { id: 'delivery', label: 'Delivery', render: (doc) => doc.delivery },
    {
      id: 'size',
      label: 'Size',
      className: 'num',
      render: (doc) => compactBytes(new TextEncoder().encode(doc.body).length),
    },
    { id: 'updated', label: 'Updated', render: (doc) => relativeTime(doc.updatedAt) },
    { id: 'open', label: '', render: () => <ChevronRight size={14} /> },
  ]
  return (
    <section>
      <PageHeader title="Docs" />
      {query.error ? <p className="text-destructive">{query.error.message}</p> : null}
      <Collection
        title="Documents"
        count={rows.length}
        search={{ query: search, onQueryChange: setSearch, placeholder: 'Filter slug or title' }}
        columns={columns}
        rows={rows}
        getKey={(doc) => doc.id}
        onOpen={(doc) =>
          void navigate({
            to: '/docs/$scope/$subject/$slug',
            params: { scope: doc.scope, subject: doc.subject ?? '_', slug: doc.slug },
            search: { id: doc.id },
          })
        }
        empty={{ title: query.isPending ? 'Loading docs...' : 'No docs match this view.' }}
      />
      {applied?.nextCursor ? (
        <div className="mt-4">
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => {
              setPages((current) => [...current, applied.items])
              setCursor(applied.nextCursor ?? undefined)
            }}
          >
            {query.isFetching ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
