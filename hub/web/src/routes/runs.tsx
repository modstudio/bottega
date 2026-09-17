import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { ProjectMark, useWindowFilters, WindowControl } from '@/components/design-system'
import { HostedRuns } from '@/components/hosted-runs'
import { useNow } from '@/lib/clock'
import { useDetailPanel } from '@/lib/detail-panel'
import { collectedTime, compactTokens, duration } from '@/lib/format'
import { isHostedMode } from '@/lib/hub-mode'
import { useDebounced } from '@/lib/use-debounced'
import { verdictTone } from '@/lib/verdict-tone'
import { useWindowState } from '@/lib/window'
import { trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { LiveDot } from '@/ui/badge/live-dot'
import { Identifier } from '@/ui/identifier/identifier'
import { PageHeader } from '@/ui/page-header/page-header'
import { PAGE_SIZES, type PageSize } from '@/ui/pagination/pagination'
import { StatRow, StatTile } from '@/ui/stat/stat'

/** The strings the server prints for a run; search on the server matches exactly these. */
type RunDisplay = {
  project: string
  took: string
  verdict: string
  exclusion: string
  tokens: string
  cost: string
  started: string
}
type RunRow = {
  id: number
  agent: string
  job: string | null
  task: string | null
  project: string | null
  at: string
  running: boolean
  status: string
  delivery: string | null
  quality: string | null
  probe: boolean
  lens: string | null
  display: RunDisplay
}
type LiveRow = {
  id: number
  agent: string
  job: string
  repo: string | null
  elapsedMs: number
  display: { project: string; elapsed: string; prompt: string }
}
type RunsPayload = {
  collectedAt: string | null
  servingSince: string
  activeAgents: string[]
  data: {
    totals: { runs: number; scored: number; voided?: number; failed: number; stale_n: number }
    vendors: { agent: string; tokens: number; runs: number }[]
    unscored: number
    facets: { agents: string[]; projects: string[] }
    matched: number
    offset: number
    limit: number
    live: LiveRow[]
    rows: RunRow[]
  }
}

const fmtMs = duration
function Verdict({ row }: { row: RunRow }) {
  if (row.running)
    return (
      <Badge tone="progress" dot>
        Running
      </Badge>
    )
  const exclusion = row.display.exclusion ? (
    <p className="text-sm text-text-muted">{row.display.exclusion}</p>
  ) : null
  const tone = row.delivery
    ? verdictTone(row.delivery, row.quality)
    : row.status !== 'ok'
      ? ('error' as const)
      : ('neutral' as const)
  return (
    <span>
      {row.probe && !row.delivery && row.status === 'ok' ? (
        <span className="text-text-muted">{row.display.verdict}</span>
      ) : row.display.verdict ? (
        <Badge tone={tone}>{row.display.verdict}</Badge>
      ) : null}
      {exclusion}
    </span>
  )
}

export const Route = createFileRoute('/runs')({ component: RunsPage })

function RunsPage() {
  if (isHostedMode()) return <HostedRuns />
  return <RunsList />
}

/** Page and page size, back to the first page whenever the question changes. */
function usePaging(question: string) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(PAGE_SIZES[1])
  const [asked, setAsked] = useState(question)
  if (asked !== question) {
    setAsked(question)
    setPage(1)
  }
  return { page, pageSize, setPage, setPageSize }
}

function RunsList() {
  const navigate = useNavigate()
  const panel = useDetailPanel()
  const openId = useParams({ strict: false }).id
  const windowState = useWindowState()
  const [openMenus, setOpenMenus] = useState(0)
  const [search, setSearch] = useState('')
  const searchQuery = useDebounced(search.trim())
  const { page, pageSize, setPage, setPageSize } = usePaging(
    `${windowState.hours}|${windowState.filters.agent}|${windowState.filters.project}|${searchQuery}`,
  )
  const now = useNow()
  const query = useQuery({
    ...trpc.run.list.queryOptions(
      {
        hours: windowState.hours,
        agent: windowState.filters.agent,
        project: windowState.filters.project,
        offset: (page - 1) * pageSize,
        limit: pageSize,
        search: searchQuery,
      },
      { refetchInterval: openMenus ? false : 30_000 },
    ),
    placeholderData: keepPreviousData,
  })
  const payload = query.data as unknown as RunsPayload | undefined
  const data = payload?.data
  const filtered = !!(windowState.filters.agent || windowState.filters.project)
  const menuChanged = (open: boolean) =>
    setOpenMenus((count) => Math.max(0, count + (open ? 1 : -1)))
  const filters = useWindowFilters({
    projects: data?.facets.projects,
    agents: data?.facets.agents,
    onOpenChange: menuChanged,
  })
  const cards = data
    ? [
        [data.totals.runs.toLocaleString(), 'runs', 'in this window'],
        [String(data.live.length), 'in flight', 'right now'],
        [data.totals.scored.toLocaleString(), 'scored', 'judged'],
        [(data.totals.voided ?? 0).toLocaleString(), 'voided', 'not routing evidence'],
        [data.unscored.toLocaleString(), 'unscored', 'teaches the router nothing'],
        [data.totals.failed.toLocaleString(), 'failed', 'counts against the agent'],
      ]
    : []
  // The server applies search and paging; these are the rows to draw.
  const liveRows = data?.live ?? []
  const runRows = data?.rows ?? []
  const liveColumns: CollectionColumn<LiveRow>[] = [
    {
      id: 'agent',
      label: 'Agent',
      render: (row) => (
        <span data-tone="success" className="inline-flex items-center gap-2 text-status-text">
          <LiveDot />
          {row.agent}
        </span>
      ),
    },
    {
      id: 'job',
      label: 'Job',
      render: (row) => <span className="text-text-muted">{row.job}</span>,
    },
    { id: 'project', label: 'Project', render: (row) => <ProjectMark name={row.repo} /> },
    {
      id: 'elapsed',
      label: 'Elapsed',
      numeric: true,
      render: (row) => fmtMs(row.elapsedMs + Math.max(0, now - query.dataUpdatedAt)),
    },
    {
      id: 'prompt',
      label: 'Prompt',
      render: (row) => (
        <span className="block max-w-lg truncate text-text-muted">{row.display.prompt}</span>
      ),
    },
  ]
  const runColumns: CollectionColumn<RunRow>[] = [
    { id: 'project', label: 'Project', render: (row) => <ProjectMark name={row.project} /> },
    {
      id: 'task',
      label: 'Task',
      render: (row) => (row.task ? <Identifier>{row.task}</Identifier> : '-'),
    },
    { id: 'agent', label: 'Agent', render: (row) => row.agent },
    {
      id: 'job',
      label: 'Job',
      render: (row) => (
        <span className="text-text-muted">
          {row.job || '-'}
          {row.lens ? ` ${row.lens}` : ''}
          {row.probe ? ' probe' : ''}
        </span>
      ),
    },
    {
      id: 'took',
      label: 'Took',
      numeric: true,
      render: (row) => (row.running ? fmtMs(now - new Date(row.at).getTime()) : row.display.took),
    },
    { id: 'verdict', label: 'Verdict', render: (row) => <Verdict row={row} /> },
    {
      id: 'tokens',
      label: 'Tokens',
      numeric: true,
      priority: 'low',
      render: (row) => row.display.tokens,
    },
    {
      id: 'cost',
      label: 'Cost',
      numeric: true,
      priority: 'low',
      render: (row) => row.display.cost,
    },
    { id: 'started', label: 'Started', render: (row) => row.display.started },
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
        subtitle={
          payload
            ? `${collectedTime(payload.collectedAt)} \u00b7 ${payload.activeAgents.length} agent${payload.activeAgents.length === 1 ? '' : 's'} working`
            : 'Loading runs...'
        }
        subtitleTitle={payload ? `Serving code since ${payload.servingSince}` : undefined}
        actions={<WindowControl />}
      />
      {query.isPending ? <p className="text-text-muted">Loading runs...</p> : null}
      {query.error ? (
        <p data-tone="error" className="text-status-text">
          could not load: {query.error.message}
        </p>
      ) : null}
      {payload && data ? (
        <>
          <StatRow>
            {cards.map(([figure, label, hint], index) => (
              <StatTile
                key={label}
                figure={figure}
                label={label}
                hint={hint}
                live={index === 1 && data.live.length > 0}
              />
            ))}
            <StatTile
              label="agents"
              hint="tokens are per agent, never summed"
              breakdown={[
                {
                  label: 'runs, all agents',
                  value: data.vendors
                    .reduce((sum, vendor) => sum + vendor.runs, 0)
                    .toLocaleString(),
                },
                ...data.vendors.map((vendor) => ({
                  label: `${vendor.agent} tokens · ${vendor.runs.toLocaleString()} runs`,
                  value: compactTokens(vendor.tokens),
                })),
              ]}
            />
          </StatRow>
          {filtered ? (
            <p className="mb-4 text-text-muted">
              the counters above count the whole window; the filter applies to the tables below.
            </p>
          ) : null}
          <Collection
            title="Running now"
            count={liveRows.length}
            columns={liveColumns}
            rows={liveRows}
            getKey={(row) => row.id}
            onOpen={(row) =>
              void navigate({ to: '/runs/$id', params: { id: String(row.id) }, resetScroll: false })
            }
            empty={{
              title: filtered
                ? 'Nothing running matches these filters.'
                : 'No delegated run is executing.',
              hint: filtered
                ? 'Clear the filters or widen the window.'
                : 'A run appears here while its agent is executing.',
            }}
          />
          <div className="mt-7">
            <Collection
              title="Runs"
              count={data.matched}
              paging={{
                page: Math.floor(data.offset / data.limit) + 1,
                pageSize: data.limit,
                total: data.matched,
                onPageChange: setPage,
                onPageSizeChange: (size) => {
                  setPageSize(size)
                  setPage(1)
                },
              }}
              search={{ query: search, onQueryChange: setSearch, placeholder: 'Search runs' }}
              filters={filters.controls}
              filtersActive={filters.active}
              panel={panel}
              selectedKey={openId}
              columns={runColumns}
              rows={runRows}
              getKey={(row) => row.id}
              onOpen={(row) =>
                void navigate({
                  to: '/runs/$id',
                  params: { id: String(row.id) },
                  resetScroll: false,
                })
              }
              empty={{
                title: 'No runs in this window.',
                hint: 'Widen the window to see earlier runs.',
              }}
            />
          </div>
          <p className="mt-4 max-w-4xl text-text-muted">
            <strong className="text-text-primary">
              Scoring is the only thing that measures whether delegation works.
            </strong>{' '}
            A run nobody judged and a run judged badly must stay distinguishable, which is why an
            unscored run shows a control rather than a blank. A probe is a calibration run and is
            never routing evidence.
          </p>
        </>
      ) : null}
    </section>
  )
}
