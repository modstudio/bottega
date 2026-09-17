import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { ProjectMark } from '@/components/design-system'
import { hostedProjectColors } from '@/components/hosted-projects'
import { useDetailPanel } from '@/lib/detail-panel'
import { duration, runEasternTime } from '@/lib/format'
import { verdictTone } from '@/lib/verdict-tone'
import { trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { PageHeader } from '@/ui/page-header/page-header'

type HostedRun = {
  id: string
  projectName: string | null
  startedAt: string
  agent: string
  job: string
  status: string
  latencyMs: number | null
  vendorCostUsd: number | null
  score: {
    delivery: string
    quality: string | null
    fidelity: string | null
  } | null
}

function ScoreBadge({ score, status }: { score: HostedRun['score']; status: string }) {
  if (!score) return <Badge>{status}</Badge>
  const text = [score.delivery, score.quality, score.fidelity].filter(Boolean).join(' / ')
  return <Badge tone={verdictTone(score.delivery, score.quality)}>{text}</Badge>
}

export function HostedRuns() {
  return <HostedRunsList />
}

function HostedRunsList() {
  const panel = useDetailPanel()
  const navigate = useNavigate()
  const [draft, setDraft] = useState({ project: '', agent: '', status: '' })
  const [filters, setFilters] = useState(draft)
  const [pages, setPages] = useState<HostedRun[][]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const projects = useQuery(trpc.record.projects.queryOptions())
  const colors = hostedProjectColors(projects.data ?? [])
  const query = useQuery(
    trpc.record.runs.queryOptions({
      limit: 20,
      cursor,
      project: filters.project || undefined,
      agent: filters.agent || undefined,
      status: filters.status || undefined,
    }),
  )

  const applied = query.data
  const rows = applied
    ? cursor
      ? [...pages.flat(), ...applied.items]
      : applied.items
    : pages.flat()

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault()
    setPages([])
    setCursor(undefined)
    setFilters(draft)
  }

  const loadMore = () => {
    if (!applied?.nextCursor) return
    setPages((current) => [...current, applied.items])
    setCursor(applied.nextCursor)
  }

  const columns: CollectionColumn<HostedRun>[] = [
    { id: 'started', label: 'Started', render: (row) => runEasternTime(row.startedAt, true) },
    {
      id: 'project',
      label: 'Project',
      render: (row) => <ProjectMark name={row.projectName} colors={colors} />,
    },
    { id: 'agent', label: 'Agent', render: (row) => row.agent },
    {
      id: 'job',
      label: 'Job',
      render: (row) => <span className="text-text-muted">{row.job}</span>,
    },
    { id: 'status', label: 'Status', render: (row) => row.status },
    {
      id: 'latency',
      label: 'Latency',
      numeric: true,
      render: (row) => (row.latencyMs == null ? '-' : duration(row.latencyMs)),
    },
    {
      id: 'cost',
      label: 'Cost',
      numeric: true,
      render: (row) => (row.vendorCostUsd == null ? '-' : `$${row.vendorCostUsd.toFixed(2)}`),
    },
    {
      id: 'score',
      label: 'Score',
      render: (row) => <ScoreBadge score={row.score} status={row.status} />,
    },
    {
      id: 'open',
      label: '',
      render: () => <ChevronRight size={14} className="text-text-muted" />,
    },
  ]

  return (
    <section>
      <PageHeader
        title="Runs"
        subtitle={query.isPending && !rows.length ? 'Loading runs...' : `${rows.length} loaded`}
        actions={
          <form className="flex flex-wrap items-center gap-2" onSubmit={applyFilters}>
            <Input
              className="h-8 w-36"
              placeholder="Project"
              value={draft.project}
              onChange={(event) => setDraft({ ...draft, project: event.target.value })}
            />
            <Input
              className="h-8 w-36"
              placeholder="Agent"
              value={draft.agent}
              onChange={(event) => setDraft({ ...draft, agent: event.target.value })}
            />
            <Input
              className="h-8 w-28"
              placeholder="Status"
              value={draft.status}
              onChange={(event) => setDraft({ ...draft, status: event.target.value })}
            />
            <Button type="submit" size="sm" variant="secondary">
              Filter
            </Button>
          </form>
        }
      />
      {query.error ? (
        <p data-tone="error" className="text-status-text">
          could not load: {query.error.message}
        </p>
      ) : null}
      <Collection
        panel={panel}
        title="Runs"
        count={rows.length}
        columns={columns}
        rows={rows}
        getKey={(row) => row.id}
        onOpen={(row) =>
          void navigate({ to: '/runs/$id', params: { id: row.id }, resetScroll: false })
        }
        empty={{
          title: query.isPending ? 'Loading runs...' : 'No runs match these filters.',
        }}
      />
      {applied?.nextCursor ? (
        <div className="mt-4">
          <Button variant="secondary" size="sm" disabled={query.isFetching} onClick={loadMore}>
            {query.isFetching ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
