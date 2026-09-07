import { useState } from 'react'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { LiveDot, PageHeader, ProjectMark, StatRow, StatTile, WindowBar } from '@/components/design-system'
import { Badge } from '@/components/badge'
import { useWindowState } from '@/lib/window'
import { collectedTime, compactTokens, duration, vendorFigures } from '@/lib/format'
import { trpc } from '@/trpc/client'
import { Collection, type CollectionColumn } from '@/components/collection'
import { Input } from '@/components/input'
import { useNow } from '@/lib/clock'
import {
  matchesRunSearch, runEasternTime, runVerdictText,
  type SearchableLiveRun, type SearchableRun,
} from '@/lib/run-search'

type RunRow = SearchableRun
type LiveRow = SearchableLiveRun
type RunsPayload = {
  collectedAt: string | null
  servingSince: string
  activeAgents: string[]
  data: {
    totals: { runs: number; scored: number; voided?: number; failed: number; stale_n: number }
    vendors: { agent: string; tokens: number }[]; unscored: number
    facets: { agents: string[]; projects: string[] }; matched: number
    live: LiveRow[]; rows: RunRow[]
  }
}

const compact = compactTokens
const fmtMs = duration
function Verdict({ row }: { row: RunRow }) {
  if (row.running) return <span className="inline-flex items-center gap-2 text-live"><LiveDot />running</span>
  const exclusion = row.evidence_excluded
    ? <p className="meta">Not routing evidence: {row.evidence_excluded}</p>
    : null
  if (row.delivery) {
    const variant = row.quality === 'wrong' || row.delivery === 'none' ? 'danger'
      : row.quality === 'mixed' || row.delivery === 'partial' ? 'warning'
        : row.quality === 'right' || row.delivery === 'full' ? 'success'
          : 'outline'
    return <span><Badge variant={variant}>{runVerdictText(row)}</Badge>{exclusion}</span>
  }
  if (row.status !== 'ok') return <span><Badge variant="danger">{row.status}</Badge>{exclusion}</span>
  if (row.probe) return <span><span className="text-muted-foreground">probe</span>{exclusion}</span>
  if (exclusion) return exclusion
  return <Badge variant="outline">Unscored</Badge>
}

export const Route = createFileRoute('/runs')({ component: RunsPage })

function RunsPage() {
  return <><RunsList /><Outlet /></>
}

function RunsList() {
  const navigate = useNavigate()
  const windowState = useWindowState()
  const [openMenus, setOpenMenus] = useState(0)
  const [search, setSearch] = useState('')
  const now = useNow()
  const query = useQuery(trpc.run.list.queryOptions({
    hours: windowState.hours, agent: windowState.filters.agent, project: windowState.filters.project,
  }, { refetchInterval: openMenus ? false : 30_000 }))
  const payload = query.data as unknown as RunsPayload | undefined
  const data = payload?.data
  const filtered = !!(windowState.filters.agent || windowState.filters.project)
  const menuChanged = (open: boolean) => setOpenMenus((count) => Math.max(0, count + (open ? 1 : -1)))
  const cards = data ? [
    [data.totals.runs.toLocaleString(), 'runs', 'in this window'],
    [String(data.live.length), 'in flight', 'right now'],
    [data.totals.scored.toLocaleString(), 'scored', 'judged'],
    [(data.totals.voided ?? 0).toLocaleString(), 'voided', 'not routing evidence'],
    [data.unscored.toLocaleString(), 'unscored', 'teaches the router nothing'],
    [data.totals.failed.toLocaleString(), 'failed', 'counts against the agent'],
    [vendorFigures(data.vendors), 'vendor tokens', 'per agent'],
  ] : []
  const matches = (row: RunRow | LiveRow) => matchesRunSearch(row, search)
  const liveRows = data?.live.filter(matches) ?? []
  const runRows = data?.rows.filter(matches) ?? []
  const liveColumns: CollectionColumn<LiveRow>[] = [
    { id: 'agent', label: 'Agent', render: (row) => <span className="inline-flex items-center gap-2 text-live"><LiveDot />{row.agent}</span> },
    { id: 'job', label: 'Job', render: (row) => <span className="text-muted-foreground">{row.job}</span> },
    { id: 'project', label: 'Project', render: (row) => <ProjectMark name={row.repo} /> },
    { id: 'elapsed', label: 'Elapsed', className: 'num', render: (row) => fmtMs(row.elapsedMs + Math.max(0, now - query.dataUpdatedAt)) },
    { id: 'prompt', label: 'Prompt', render: (row) => <span className="block max-w-lg truncate text-muted-foreground">{row.prompt_head.slice(0, 90)}</span> },
  ]
  const runColumns: CollectionColumn<RunRow>[] = [
    { id: 'project', label: 'Project', render: (row) => <ProjectMark name={row.project} /> },
    { id: 'task', label: 'Task', render: (row) => <strong>{row.task ?? '-'}</strong> },
    { id: 'agent', label: 'Agent', render: (row) => row.agent },
    { id: 'job', label: 'Job', render: (row) => <span className="text-muted-foreground">{row.job || '-'}{row.lens ? ` ${row.lens}` : ''}{row.probe ? ' probe' : ''}</span> },
    { id: 'took', label: 'Took', className: 'num', render: (row) => row.running ? fmtMs(now - new Date(row.at).getTime()) : row.engaged },
    { id: 'verdict', label: 'Verdict', render: (row) => <Verdict row={row} /> },
    { id: 'tokens', label: 'Tokens', className: 'num', render: (row) => compact(row.tokens) },
    { id: 'cost', label: 'Cost', className: 'num', render: (row) => row.costUsd == null ? '-' : `$${row.costUsd.toFixed(2)}` },
    { id: 'started', label: 'Started', render: (row) => runEasternTime(row.at, true) },
    { id: 'open', label: '', render: () => <ChevronRight size={14} className="text-muted-foreground" /> },
  ]

  return <section>
    <PageHeader title="Runs" subtitle={payload ? `${collectedTime(payload.collectedAt)} \u00b7 ${payload.activeAgents.length} agent${payload.activeAgents.length === 1 ? '' : 's'} working` : 'Loading runs...'} subtitleTitle={payload ? `Serving code since ${payload.servingSince}` : undefined} actions={data ? <><Input type="search" className="h-8 w-56" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search visible runs" /><WindowBar projects={data.facets.projects} agents={data.facets.agents} onOpenChange={menuChanged} /></> : null} />
    {query.isPending ? <p className="text-muted-foreground">Loading runs...</p> : null}
    {query.error ? <p className="text-destructive">could not load: {query.error.message}</p> : null}
    {payload && data ? <>
      <StatRow className="two-rows">{cards.map(([figure, label, hint], index) => <StatTile key={label} figure={figure} label={label} hint={hint} live={index === 1 && data.live.length > 0} />)}</StatRow>
      {filtered ? <p className="mb-4 text-muted-foreground">the counters above count the whole window; the filter applies to the tables below.</p> : null}
      <Collection title="Running now" count={liveRows.length} columns={liveColumns} rows={liveRows} getKey={(row) => row.id} onOpen={(row) => void navigate({ to: '/runs/$id', params: { id: String(row.id) } })} empty={{ title: filtered ? 'Nothing running matches these filters.' : 'No delegated run is executing.', hint: filtered ? 'Clear the filters or widen the window.' : 'A run appears here while its agent is executing.' }} />
      <div className="mt-7"><Collection title="Runs" count={runRows.length} columns={runColumns} rows={runRows} getKey={(row) => row.id} onOpen={(row) => void navigate({ to: '/runs/$id', params: { id: String(row.id) } })} empty={{ title: 'No runs in this window.', hint: 'Widen the window to see earlier runs.' }} /></div>
      <p className="mt-4 max-w-4xl text-muted-foreground"><strong className="text-foreground">Scoring is the only thing that measures whether delegation works.</strong>{' '}A run nobody judged and a run judged badly must stay distinguishable, which is why an unscored run shows a control rather than a blank. A probe is a calibration run and is never routing evidence.</p>
    </> : null}
  </section>
}
