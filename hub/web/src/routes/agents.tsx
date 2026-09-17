import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { PageHeader } from '@/components/design-system'
import { SnapshotHeader } from '@/components/hosted-snapshot'
import { isHostedMode } from '@/lib/hub-mode'
import { type AgentRow, trpc } from '@/trpc/client'
import { Companion } from '@/ui/companion/companion'
import { DisplayRow } from '@/ui/form-layout/form-layout'

export const Route = createFileRoute('/agents')({
  validateSearch: (search: Record<string, unknown>) => ({
    agent: typeof search.agent === 'string' ? search.agent : undefined,
  }),
  component: () => (isHostedMode() ? <HostedAgentsPage /> : <AgentsPage />),
})

const finite = (value: number | null) => (value == null ? 'unbounded' : value.toLocaleString())
const columns: CollectionColumn<AgentRow>[] = [
  { id: 'name', label: 'Agent', render: (row) => <strong>{row.name}</strong> },
  { id: 'model', label: 'Model', render: (row) => row.model },
  {
    id: 'caps',
    label: 'Capabilities',
    render: (row) =>
      Object.entries(row.caps)
        .filter(([, has]) => has)
        .map(([name]) => name)
        .join(', '),
  },
  { id: 'timeout', label: 'Timeout', render: (row) => `${row.timeoutMs / 60_000} min` },
]

function AgentsPage() {
  const query = useQuery(trpc.catalog.agents.queryOptions())
  return <AgentsView data={query.data} pending={query.isPending} error={query.error} />
}

function HostedAgentsPage() {
  const [machineId, setMachineId] = useState<string>()
  const query = useQuery(trpc.record.agents.queryOptions({ machineId }))
  return (
    <AgentsView
      data={query.data?.data}
      pending={query.isPending}
      error={query.error}
      header={
        query.data ? (
          <SnapshotHeader
            title="Agents"
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

function AgentsView({
  data,
  pending,
  error,
  header,
}: {
  data: AgentRow[] | undefined
  pending: boolean
  error: { message: string } | null
  header?: React.ReactNode
}) {
  const navigate = useNavigate()
  const { agent } = Route.useSearch()
  const [search, setSearch] = useState('')
  const rows = useMemo(
    () =>
      (data ?? []).filter((row) =>
        `${row.name} ${row.model}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [data, search],
  )
  const selected = data?.find((row) => row.name === agent)
  const close = () =>
    void navigate({
      to: '/agents',
      search: { agent: undefined },
      replace: true,
      resetScroll: false,
    })
  return (
    <section>
      {header ?? <PageHeader title="Agents" subtitle="Code-declared runners and their limits" />}
      {error ? (
        <p data-tone="error" className="text-status-text">
          {error.message}
        </p>
      ) : null}
      <Collection
        title="Agents"
        count={rows.length}
        search={{ query: search, onQueryChange: setSearch, placeholder: 'Search agents' }}
        columns={columns}
        panel={
          agent ? (
            <Companion
              onClose={close}
              title={selected?.name ?? agent ?? 'Agent'}
              subtitle="Code-declared; inspectable, not editable"
            >
              {selected ? (
                <>
                  <DisplayRow label="Model" value={selected.model} />
                  <DisplayRow
                    label="Capabilities"
                    value={Object.entries(selected.caps)
                      .map(([name, has]) => `${name}: ${has ? 'yes' : 'no'}`)
                      .join(' · ')}
                  />
                  <DisplayRow label="Context tokens" value={finite(selected.contextTokens)} />
                  <DisplayRow label="Max prompt bytes" value={finite(selected.maxPromptBytes)} />
                  <DisplayRow label="Timeout" value={`${selected.timeoutMs / 60_000} minutes`} />
                </>
              ) : (
                <p data-tone="error" className="text-status-text">
                  Unknown agent.
                </p>
              )}
            </Companion>
          ) : undefined
        }
        selectedKey={agent}
        rows={rows}
        getKey={(row) => row.name}
        onOpen={(row) =>
          void navigate({ to: '/agents', search: { agent: row.name }, resetScroll: false })
        }
        empty={{ title: pending ? 'Loading agents...' : 'No agents match.' }}
      />
    </section>
  )
}
