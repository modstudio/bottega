import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Collection, type CollectionColumn } from '@/components/collection'
import { DisplayRow } from '@/components/fields'
import { PageHeader } from '@/components/design-system'
import { Sheet } from '@/components/sheet'
import { trpc, type AgentRow } from '@/trpc/client'

export const Route = createFileRoute('/agents')({
  validateSearch: (search: Record<string, unknown>) => ({
    agent: typeof search.agent === 'string' ? search.agent : undefined,
  }),
  component: AgentsPage,
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
  const navigate = useNavigate()
  const { agent } = Route.useSearch()
  const [search, setSearch] = useState('')
  const rows = useMemo(
    () =>
      (query.data ?? []).filter((row) =>
        `${row.name} ${row.model}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [query.data, search],
  )
  const selected = query.data?.find((row) => row.name === agent)
  const close = () => void navigate({ to: '/agents', search: { agent: undefined }, replace: true })
  return (
    <section>
      <PageHeader title="Agents" subtitle="Code-declared runners and their limits" />
      {query.error ? <p className="text-destructive">{query.error.message}</p> : null}
      <Collection
        title="Agents"
        count={rows.length}
        search={{ query: search, onQueryChange: setSearch, placeholder: 'Search agents' }}
        columns={columns}
        rows={rows}
        getKey={(row) => row.name}
        onOpen={(row) => void navigate({ to: '/agents', search: { agent: row.name } })}
        empty={{ title: query.isPending ? 'Loading agents...' : 'No agents match.' }}
      />
      <Sheet
        open={Boolean(agent)}
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
          <p className="text-destructive">Unknown agent.</p>
        )}
      </Sheet>
    </section>
  )
}
