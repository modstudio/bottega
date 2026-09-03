import { useState } from 'react'
import { createFileRoute, Link, Outlet, useMatches } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { EmptyState, LiveDot, PageHeader, ProjectMark, SectionTitle, StatRow, StatTile, WindowBar } from '@/components/design-system'
import { Badge } from '@/components/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/table'
import { useWindowState } from '@/lib/window'
import { collectedTime, compactTokens, duration } from '@/lib/format'
import { trpc } from '@/trpc/client'

type RunRow = {
  id: number; agent: string; job: string | null; task: string | null; project: string | null
  at: string; engaged: string; running: boolean; status: string; delivery: string | null
  quality: string | null; tokens: number | null; costUsd: number | null; probe: boolean
  lens: string | null
}
type LiveRow = {
  id: number; agent: string; job: string; repo: string | null; elapsedMs: number; prompt_head: string
}
type RunsPayload = {
  collectedAt: string | null
  servingSince: string
  activeAgents: string[]
  data: {
    totals: { runs: number; scored: number; failed: number; toks: number }; unscored: number
    facets: { agents: string[]; projects: string[] }; matched: number
    live: LiveRow[]; rows: RunRow[]
  }
}

const compact = compactTokens
const fmtMs = duration
function easternTime(value: string, includeDay = false) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', ...(includeDay ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  const time = `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`
  return includeDay ? `${part('month')} ${part('day')} ${time}` : time
}

function Verdict({ row }: { row: RunRow }) {
  if (row.running) return <span className="inline-flex items-center gap-2 text-live"><LiveDot />running</span>
  if (row.delivery) return <Badge variant={row.quality === 'wrong' ? 'destructive' : 'outline'}>{row.delivery}{row.quality ? ` / ${row.quality}` : ''}</Badge>
  if (row.status !== 'ok') return <Badge variant="destructive">{row.status}</Badge>
  if (row.probe) return <span className="text-muted-foreground">probe</span>
  return <span>Unscored</span>
}

export const Route = createFileRoute('/runs')({ component: RunsPage })

function RunsPage() {
  const matches = useMatches()
  const leaf = matches[matches.length - 1]
  if (leaf && leaf.routeId !== '/runs') return <Outlet />
  return <RunsList />
}

function RunsList() {
  const windowState = useWindowState()
  const [openMenus, setOpenMenus] = useState(0)
  const query = useQuery(trpc.run.list.queryOptions({
    hours: windowState.hours, agent: windowState.filters.agent, project: windowState.filters.project,
  }, { refetchInterval: openMenus ? false : 2000 }))
  const payload = query.data as unknown as RunsPayload | undefined
  const data = payload?.data
  const filtered = !!(windowState.filters.agent || windowState.filters.project)
  const menuChanged = (open: boolean) => setOpenMenus((count) => Math.max(0, count + (open ? 1 : -1)))
  const cards = data ? [
    [data.totals.runs.toLocaleString(), 'runs', 'in this window'],
    [String(data.live.length), 'in flight', 'right now'],
    [data.totals.scored.toLocaleString(), 'scored', 'judged'],
    [data.unscored.toLocaleString(), 'unscored', 'teaches the router nothing'],
    [data.totals.failed.toLocaleString(), 'failed', 'counts against the agent'],
    [compact(data.totals.toks), 'vendor tokens', 'across every agent'],
  ] : []

  return <section>
    <PageHeader title="Runs" subtitle={payload ? `${collectedTime(payload.collectedAt)} \u00b7 ${payload.activeAgents.length} agent${payload.activeAgents.length === 1 ? '' : 's'} working` : 'Loading runs...'} subtitleTitle={payload ? `Serving code since ${payload.servingSince}` : undefined} actions={data ? <WindowBar projects={data.facets.projects} agents={data.facets.agents} onOpenChange={menuChanged} /> : null} />
    {query.isPending ? <p className="text-muted-foreground">Loading runs...</p> : null}
    {query.error ? <p className="text-destructive">could not load: {query.error.message}</p> : null}
    {payload && data ? <>
      <StatRow className="two-rows">{cards.map(([figure, label, hint], index) => <StatTile key={label} figure={figure} label={label} hint={hint} live={index === 1 && data.live.length > 0} />)}</StatRow>
      {filtered ? <p className="mb-4 text-muted-foreground">the counters above count the whole window; the filter applies to the tables below.</p> : null}
      <SectionTitle detail={data.live.length ? `${data.live.length} delegated runs in flight${filtered ? ' here' : ''}` : filtered ? 'Nothing running matches these filters' : 'No delegated run is executing'}>Running now</SectionTitle>
      {data.live.length ? <div className="border border-border"><Table><TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Job</TableHead><TableHead>Project</TableHead><TableHead className="num">Elapsed</TableHead><TableHead>Prompt</TableHead></TableRow></TableHeader><TableBody>{data.live.map((row) => <TableRow key={row.id}><TableCell className="text-live"><span className="inline-flex items-center gap-2"><LiveDot />{row.agent}</span></TableCell><TableCell className="text-muted-foreground">{row.job}</TableCell><TableCell><ProjectMark name={row.repo} /></TableCell><TableCell className="num">{fmtMs(row.elapsedMs)}</TableCell><TableCell className="max-w-lg truncate text-muted-foreground">{row.prompt_head.slice(0, 90)}</TableCell></TableRow>)}</TableBody></Table></div> : <EmptyState title="No runs are running now." hint={filtered ? 'Clear the filters to see all live runs.' : 'A delegated run appears here while it is executing.'} />}
      <SectionTitle detail={filtered ? `${data.matched} matching, newest first` : `${data.rows.length} delegated runs, newest first`}>Runs</SectionTitle>
      {data.rows.length ? <div className="border border-border"><Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Task</TableHead><TableHead>Agent</TableHead><TableHead>Job</TableHead><TableHead className="num">Took</TableHead><TableHead>Verdict</TableHead><TableHead className="num">Tokens</TableHead><TableHead className="num">Cost</TableHead><TableHead>Started</TableHead><TableHead /></TableRow></TableHeader><TableBody>{data.rows.map((row) => <TableRow key={row.id} className={`data-table-link ${row.probe ? 'opacity-70' : ''}`}><TableCell><Link to="/runs/$id" params={{ id: String(row.id) }} className="row-link font-normal"><ProjectMark name={row.project} /></Link></TableCell><TableCell className="whitespace-nowrap font-semibold">{row.task ?? '-'}</TableCell><TableCell className={row.running ? 'text-live' : ''}>{row.agent}</TableCell><TableCell className="text-muted-foreground">{row.job || '-'}{row.lens ? ` ${row.lens}` : ''}{row.probe ? ' probe' : ''}</TableCell><TableCell className="num whitespace-nowrap">{row.engaged}</TableCell><TableCell className="whitespace-nowrap"><Verdict row={row} /></TableCell><TableCell className="num text-muted-foreground" title={row.tokens?.toLocaleString()}>{compact(row.tokens)}</TableCell><TableCell className="num text-muted-foreground">{row.costUsd == null ? '-' : `$${row.costUsd.toFixed(2)}`}</TableCell><TableCell className="whitespace-nowrap text-muted-foreground">{easternTime(row.at, true)}</TableCell><TableCell><ChevronRight size={14} className="text-muted-foreground" /></TableCell></TableRow>)}</TableBody></Table></div> : <EmptyState title="No runs in this window." hint="Widen the window or clear the filters." />}
      <p className="mt-4 max-w-4xl text-muted-foreground"><strong className="text-foreground">Scoring is the only thing that measures whether delegation works.</strong>{' '}A run nobody judged and a run judged badly must stay distinguishable, which is why an unscored run shows a control rather than a blank. A probe is a calibration run and is never routing evidence.</p>
    </> : null}
  </section>
}
