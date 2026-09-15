import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Collection, type CollectionColumn } from '@/components/collection'
import { DisplayRow } from '@/components/fields'
import { PageHeader } from '@/components/design-system'
import { Sheet } from '@/components/sheet'
import { trpc, type JobRow } from '@/trpc/client'

export const Route = createFileRoute('/jobs')({
  validateSearch: (search: Record<string, unknown>) => ({
    job: typeof search.job === 'string' ? search.job : undefined,
  }),
  component: JobsPage,
})

const columns: CollectionColumn<JobRow>[] = [
  { id: 'name', label: 'Job', render: (row) => <strong>{row.name}</strong> },
  { id: 'what', label: 'What', render: (row) => <span className="font-sans">{row.what}</span> },
  { id: 'needs', label: 'Needs', render: (row) => Object.keys(row.needs).join(', ') || '-' },
  { id: 'prefer', label: 'Prefers', render: (row) => row.prefer.join(', ') },
]

function JobsPage() {
  const query = useQuery(trpc.catalog.jobs.queryOptions())
  const navigate = useNavigate()
  const { job } = Route.useSearch()
  const [search, setSearch] = useState('')
  const rows = useMemo(
    () =>
      (query.data ?? []).filter((row) =>
        `${row.name} ${row.what}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [query.data, search],
  )
  const selected = query.data?.find((row) => row.name === job)
  const close = () => void navigate({ to: '/jobs', search: { job: undefined }, replace: true })
  return (
    <section>
      <PageHeader title="Jobs" subtitle="Code-declared work the orchestrator can route" />
      {query.error ? <p className="text-destructive">{query.error.message}</p> : null}
      <Collection
        title="Job types"
        count={rows.length}
        search={{ query: search, onQueryChange: setSearch, placeholder: 'Search jobs' }}
        columns={columns}
        rows={rows}
        getKey={(row) => row.name}
        onOpen={(row) => void navigate({ to: '/jobs', search: { job: row.name } })}
        empty={{ title: query.isPending ? 'Loading jobs...' : 'No jobs match.' }}
      />
      <Sheet
        open={Boolean(job)}
        onClose={close}
        title={selected?.name ?? job ?? 'Job'}
        subtitle="Code-declared; inspectable, not editable"
      >
        {selected ? (
          <>
            <DisplayRow label="What" value={selected.what} />
            <DisplayRow
              label="Needs"
              value={
                Object.entries(selected.needs)
                  .filter(([, needed]) => needed)
                  .map(([name]) => name)
                  .join(', ') || 'none'
              }
            />
            <DisplayRow label="Context tokens" value={selected.contextTokens.toLocaleString()} />
            <DisplayRow
              label="Timeout"
              value={
                selected.timeoutMs ? `${selected.timeoutMs / 60_000} minutes` : 'agent default'
              }
            />
            <DisplayRow label="Prefer" value={selected.prefer.join(' → ')} />
            <DisplayRow label="Findings" value={selected.findings ? 'yes' : 'no'} />
          </>
        ) : (
          <p className="text-destructive">Unknown job.</p>
        )}
      </Sheet>
    </section>
  )
}
