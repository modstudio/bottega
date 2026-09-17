import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { PageHeader } from '@/components/design-system'
import { DisplayRow } from '@/components/fields'
import { SnapshotHeader } from '@/components/hosted-snapshot'
import { isHostedMode } from '@/lib/hub-mode'
import { type JobRow, trpc } from '@/trpc/client'
import { Companion } from '@/ui/companion/companion'

export const Route = createFileRoute('/jobs')({
  validateSearch: (search: Record<string, unknown>) => ({
    job: typeof search.job === 'string' ? search.job : undefined,
  }),
  component: () => (isHostedMode() ? <HostedJobsPage /> : <JobsPage />),
})

const columns: CollectionColumn<JobRow>[] = [
  { id: 'name', label: 'Job', render: (row) => <strong>{row.name}</strong> },
  { id: 'what', label: 'What', render: (row) => <span className="font-sans">{row.what}</span> },
  { id: 'needs', label: 'Needs', render: (row) => Object.keys(row.needs).join(', ') || '-' },
  { id: 'prefer', label: 'Prefers', render: (row) => row.prefer.join(', ') },
]

function JobsPage() {
  const query = useQuery(trpc.catalog.jobs.queryOptions())
  return <JobsView data={query.data} pending={query.isPending} error={query.error} />
}

function HostedJobsPage() {
  const [machineId, setMachineId] = useState<string>()
  const query = useQuery(trpc.record.jobs.queryOptions({ machineId }))
  return (
    <JobsView
      data={query.data?.data}
      pending={query.isPending}
      error={query.error}
      header={
        query.data ? (
          <SnapshotHeader
            title="Jobs"
            takenAt={query.data.takenAt}
            machineId={query.data.machineId}
            machines={query.data.machines}
            onMachineChange={setMachineId}
          />
        ) : undefined
      }
    />
  )
}

function JobsView({
  data,
  pending,
  error,
  header,
}: {
  data: JobRow[] | undefined
  pending: boolean
  error: { message: string } | null
  header?: React.ReactNode
}) {
  const navigate = useNavigate()
  const { job } = Route.useSearch()
  const [search, setSearch] = useState('')
  const rows = useMemo(
    () =>
      (data ?? []).filter((row) =>
        `${row.name} ${row.what}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [data, search],
  )
  const selected = data?.find((row) => row.name === job)
  const close = () => void navigate({ to: '/jobs', search: { job: undefined }, replace: true })
  return (
    <section>
      {header ?? (
        <PageHeader title="Jobs" subtitle="Code-declared work the orchestrator can route" />
      )}
      {error ? <p className="text-destructive">{error.message}</p> : null}
      <Collection
        title="Job types"
        count={rows.length}
        search={{ query: search, onQueryChange: setSearch, placeholder: 'Search jobs' }}
        columns={columns}
        panel={
          job ? (
            <Companion
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
                  <DisplayRow
                    label="Context tokens"
                    value={selected.contextTokens.toLocaleString()}
                  />
                  <DisplayRow
                    label="Timeout"
                    value={
                      selected.timeoutMs
                        ? `${selected.timeoutMs / 60_000} minutes`
                        : 'agent default'
                    }
                  />
                  <DisplayRow label="Prefer" value={selected.prefer.join(' → ')} />
                  <DisplayRow label="Findings" value={selected.findings ? 'yes' : 'no'} />
                </>
              ) : (
                <p className="text-destructive">Unknown job.</p>
              )}
            </Companion>
          ) : undefined
        }
        rows={rows}
        getKey={(row) => row.name}
        onOpen={(row) => void navigate({ to: '/jobs', search: { job: row.name } })}
        empty={{ title: pending ? 'Loading jobs...' : 'No jobs match.' }}
      />
    </section>
  )
}
