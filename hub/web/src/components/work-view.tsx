import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { EmptyState, LiveDot, PageHeader, ProjectMark, Segmented, StatRow, StatTile, WindowBar, projectVars, responseSubtitle, useProjectColors } from '@/components/design-system'
import { Badge } from '@/components/badge'
import { Input } from '@/components/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/table'
import { setWorkCounts, useWindowState } from '@/lib/window'
import { trpc, type BoardResponse, type FlightResponse } from '@/trpc/client'
import { compactTokens, duration, relativeTime } from '@/lib/format'

type WorkName = 'flight' | 'done'
type TaskData = FlightResponse['data']
type TaskRow = TaskData['rows'][number]
type Run = TaskRow['runs'][number]
type Facets = { projects: string[]; agents: string[] }

const number = new Intl.NumberFormat('en-US')

const compact = compactTokens
const formatMs = duration
const ago = relativeTime

function Status({ row }: { row: Pick<TaskRow, 'key' | 'status' | 'statusCategory'> }) {
  if (!row.statusCategory) {
    return <span className="text-muted-foreground" title={row.key ? 'no tracker reached this task' : undefined}>{row.key ? 'unknown' : 'no ticket'}</span>
  }
  return <StatusBadge status={row.statusCategory} title={row.status ?? row.statusCategory} />
}

function StatusBadge({ status, title }: { status: string; title?: string }) {
  const variant = status === 'active' ? 'live'
    : status === 'review' ? 'info'
      : status === 'dropped' ? 'danger'
        : 'outline'
  return <Badge variant={variant} title={title}>{status}</Badge>
}

function WindowChrome({ title, response, facets, onDropdown }: {
  title: string
  response: Pick<FlightResponse, 'engaged' | 'activeAgents' | 'tasksShipped' | 'collectedAt' | 'servingSince' | 'counts'>
  facets: Facets
  onDropdown: (open: boolean) => void
}) {
  useEffect(() => setWorkCounts(response.counts), [response.counts])
  const subtitle = responseSubtitle(response)
  return (
    <>
      <PageHeader title={title} subtitle={subtitle.text} subtitleTitle={subtitle.title} actions={<WindowBar projects={facets.projects} agents={facets.agents} onOpenChange={onDropdown} />} />
      <StatRow><StatTile figure={response.engaged} label="Engaged" live={response.activeAgents.length > 0} /><StatTile figure={response.activeAgents.length} label="Agents working" hint={response.activeAgents.join(', ') || 'No agent on a task'} /><StatTile figure={number.format(response.tasksShipped)} label="Tasks shipped" hint="Last 14 days" /></StatRow>
    </>
  )
}

const columns = [
  { id: 'project', label: 'Project', numeric: false, get: (row: TaskRow) => row.project || '' },
  { id: 'task', label: 'Task', numeric: false, get: (row: TaskRow) => row.key || '' },
  { id: 'title', label: 'Title', numeric: false, get: (row: TaskRow) => row.title || '' },
  { id: 'status', label: 'Status', numeric: false, get: (row: TaskRow) => row.statusCategory || '' },
  { id: 'updated', label: 'Updated', numeric: true, get: (row: TaskRow) => row.lastAt },
  { id: 'engaged', label: 'Engaged', numeric: true, get: (row: TaskRow) => row.engagedMs },
  { id: 'claude', label: 'Claude', numeric: true, get: (row: TaskRow) => row.claudeTokens },
  { id: 'vendor', label: 'Vendor', numeric: true, get: (row: TaskRow) => row.vendorTokens },
  { id: 'runs', label: 'Runs', numeric: true, get: (row: TaskRow) => row.runs.length },
] as const

type Sort = { col: typeof columns[number]['id']; dir: 1 | -1 }

function RunLine({ run }: { run: Run }) {
  return (
    <div className="ml-6 grid grid-cols-[8rem_minmax(8rem,1fr)_6rem_5rem_7rem] gap-3 px-3 py-1 text-muted-foreground">
      <span>{run.agent ?? '-'}</span><span>{run.job || ''}</span>
      <span className="text-right">{formatMs(run.ms)}</span><span className={run.running ? 'inline-flex items-center gap-2 text-live' : ''}>{run.running ? <><LiveDot />running</> : 'done'}</span>
      <span className="text-right">{compact(run.tokens)}{run.costUsd != null ? ` $${run.costUsd.toFixed(2)}` : ''}</span>
    </div>
  )
}

function TaskTable({ rows }: { rows: TaskRow[] }) {
  const [sort, setSort] = useState<Sort>({ col: 'updated', dir: -1 })
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.id === sort.col) ?? columns[4]
    return [...rows].sort((a, b) => {
      const x = column.get(a) ?? 0
      const y = column.get(b) ?? 0
      const compared = column.numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y))
      return (compared || b.lastAt - a.lastAt) * (column.numeric ? sort.dir : -sort.dir)
    })
  }, [rows, sort])
  const changeSort = (col: Sort['col']) => setSort((current) => current.col === col
    ? { col, dir: current.dir === -1 ? 1 : -1 }
    : { col, dir: -1 })
  return (
    <div className="overflow-x-auto border border-border">
      <Table className="text-[12px]">
        <TableHeader><TableRow>{columns.map((column) => (
          <TableHead key={column.id} className={`h-9 px-3 ${column.numeric ? 'text-right' : ''}`}>
            <button type="button" onClick={() => changeSort(column.id)}>{column.label}{sort.col === column.id ? sort.dir < 0 ? ' v' : ' ^' : ''}</button>
          </TableHead>
        ))}</TableRow></TableHeader>
        <TableBody>{sorted.map((row) => {
          const runs = row.runs ?? []
          const isOpen = row.key ? opened.has(row.key) : false
          const visible = isOpen ? runs : runs.filter((run) => run.running)
          return [
            <TableRow key={`${row.project}:${row.key}:task`}>
              <TableCell className="px-3 py-2"><ProjectMark name={row.project} /></TableCell>
              <TableCell className="whitespace-nowrap px-3 py-2 font-semibold">{row.key}</TableCell>
              <TableCell className="max-w-md px-3 py-2">{row.title || <span className="text-muted-foreground">{row.source === 'git' ? 'title not known, derived from commits' : 'no tracker record yet'}</span>}</TableCell>
              <TableCell className="px-3 py-2"><Status row={row} /></TableCell>
              <TableCell className={`px-3 py-2 text-right ${row.workingNow ? 'text-live' : 'text-muted-foreground'}`}>{row.workingNow ? <span className="inline-flex items-center gap-2"><LiveDot />now</span> : ago(row.lastAt)}</TableCell>
              <TableCell className="px-3 py-2 text-right font-semibold">{row.engaged}</TableCell>
              <TableCell className="px-3 py-2 text-right" title={number.format(row.claudeTokens)}>{compact(row.claudeTokens)}</TableCell>
              <TableCell className="px-3 py-2 text-right text-muted-foreground" title={number.format(row.vendorTokens)}>{row.vendorTokens ? compact(row.vendorTokens) : '-'}</TableCell>
              <TableCell className="px-3 py-2 text-right">{runs.length ? <button type="button" className="inline-flex items-center" onClick={() => row.key && setOpened((current) => { const next = new Set(current); if (next.has(row.key!)) next.delete(row.key!); else next.add(row.key!); return next })}>{isOpen ? 'hide' : runs.length}<ChevronRight className={isOpen ? 'rotate-90' : ''} size={13} /></button> : '-'}</TableCell>
            </TableRow>,
            visible.length ? <TableRow key={`${row.project}:${row.key}:runs`}><TableCell colSpan={9} className="bg-muted/20 px-8 py-2">{visible.map((run, index) => <RunLine key={`${run.start}:${index}`} run={run} />)}</TableCell></TableRow> : null,
          ]
        })}</TableBody>
      </Table>
    </div>
  )
}

function LooseTable({ rows }: { rows: TaskRow[] }) {
  return <div className="max-w-3xl overflow-x-auto border border-border"><Table className="text-[12px]"><TableHeader><TableRow>
    <TableHead>Project</TableHead><TableHead className="text-right">Updated</TableHead><TableHead className="text-right">Engaged</TableHead><TableHead className="text-right">Claude</TableHead><TableHead className="text-right">Vendor</TableHead>
  </TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.project}>
    <TableCell><ProjectMark name={row.project} /></TableCell><TableCell className="text-right text-muted-foreground">{row.workingNow ? 'now' : ago(row.lastAt)}</TableCell><TableCell className="text-right font-semibold">{row.engaged}</TableCell><TableCell className="text-right">{compact(row.claudeTokens)}</TableCell><TableCell className="text-right text-muted-foreground">{row.vendorTokens ? compact(row.vendorTokens) : '-'}</TableCell>
  </TableRow>)}</TableBody></Table></div>
}

function TaskContent({ name, data }: { name: WorkName; data: TaskData }) {
  const window = useWindowState()
  const tasks = data.rows.filter((row) => row.key)
  const loose = data.rows.filter((row) => !row.key)
  const filtered = Boolean(window.filters.agent || window.filters.project)
  const hasRows = data.rows.length > 0
  return <>
    {tasks.length ? <TaskTable rows={tasks} /> : <EmptyState title={filtered ? 'No tasks match these filters.' : name === 'flight' ? 'No work is in flight.' : 'No tasks were completed in this window.'} hint={filtered ? 'Clear the filters or widen the window.' : name === 'flight' ? 'Work appears here when a task becomes active.' : 'Widen the window to see earlier completed work.'} />}
    {loose.length ? <section className="mt-7"><div className="mb-3 flex items-baseline gap-3"><h2 className="font-sans font-semibold">No ticket</h2><span className="text-muted-foreground">work these projects cannot attribute to a task</span></div><LooseTable rows={loose} /></section> : null}
    {data.dropped.length ? <p className="mt-5 max-w-4xl text-muted-foreground"><strong className="text-foreground">Not shown here:</strong> {data.dropped.map((item) => `${item.tasks} task${item.tasks === 1 ? '' : 's'} (${item.engaged}) ${item.reason}`).join('; ')}. In flight means being worked on right now, or marked active in its tracker.</p> : null}
    {tasks.length && window.filters.agent ? <p className="mt-5 max-w-4xl text-muted-foreground"><strong className="text-foreground">Filtered to tasks {window.filters.agent} worked on.</strong> The rows are the whole task: engaged time is still the union of every agent and session on it, not {window.filters.agent}'s share.</p> : null}
    {hasRows ? <p className="mt-5 max-w-4xl text-muted-foreground"><strong className="text-foreground">Engaged time is the union of every agent's spans, never their sum.</strong> A session waiting on a delegated agent is not idle, and two agents at once did not take twice as long. That is why the estate total above is smaller than these rows added together.</p> : null}
  </>
}

export function TaskView({ name }: { name: WorkName }) {
  const window = useWindowState()
  const [menus, setMenus] = useState(0)
  const options = name === 'flight'
    ? trpc.work.flight.queryOptions({ hours: window.hours, filters: window.filters })
    : trpc.work.done.queryOptions({ hours: window.hours, filters: window.filters })
  // Keep the last result on screen while a new filter or window loads: a pending
  // state here unmounts the toolbar, which destroys the control being used.
  const query = useQuery({ ...options, placeholderData: keepPreviousData, refetchInterval: menus ? false : 2000 })
  const dropdown = (open: boolean) => setMenus((count) => Math.max(0, count + (open ? 1 : -1)))
  if (query.isPending) return <p className="text-muted-foreground">Loading {name}...</p>
  if (query.error) return <p className="text-destructive">{query.error.message}</p>
  return <section><WindowChrome title={name === 'flight' ? 'In flight' : 'Done'} response={query.data} facets={query.data.data.facets} onDropdown={dropdown} /><TaskContent name={name} data={query.data.data} /></section>
}

type BoardCard = BoardResponse['data']['cards'][number]
type BoardGroup = 'status' | 'project'
type BoardLayout = 'cards' | 'table'

function readBoardSettings(): { layout: BoardLayout; group: BoardGroup } {
  try {
    const saved = JSON.parse(localStorage.getItem('hub-board') || '{}') as Record<string, unknown>
    return { layout: saved.layout === 'table' ? 'table' : 'cards', group: saved.group === 'project' ? 'project' : 'status' }
  } catch { return { layout: 'cards', group: 'status' } }
}

function BoardOwner({ card }: { card: BoardCard }) {
  const ours = card.source === 'local'
  return <Badge variant="outline" title={ours ? 'issued here - yours to change' : card.source === 'git' ? 'inferred from commit subjects; no tracker record' : "synced from this project's own tracker"}>{ours ? 'ours' : card.source}</Badge>
}

function BoardCardView({ card }: { card: BoardCard }) {
  const colors = useProjectColors()
  return <div className="proj-card border border-border p-3" style={projectVars(colors, card.project)}><div className="whitespace-nowrap font-semibold">{card.key}</div><div className="mt-1 font-sans text-[12.5px]">{card.title || <span className="text-muted-foreground">No title from its tracker</span>}</div><div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]"><span>{card.project || 'elsewhere'}</span><BoardOwner card={card} />{card.assignee ? <span>{card.assignee}</span> : null}{card.workingNow ? <span className="inline-flex items-center gap-2 text-live"><LiveDot />working now</span> : null}</div></div>
}

export function BoardView() {
  const window = useWindowState()
  const [menus, setMenus] = useState(0)
  const [settings, setSettings] = useState(readBoardSettings)
  const [search, setSearch] = useState('')
  const [why, setWhy] = useState(false)
  const query = useQuery({ ...trpc.work.board.queryOptions({ hours: window.hours, filters: window.filters }), placeholderData: keepPreviousData, refetchInterval: menus ? false : 2000 })
  const dropdown = (open: boolean) => setMenus((count) => Math.max(0, count + (open ? 1 : -1)))
  const remember = (next: Partial<typeof settings>) => setSettings((current) => {
    const value = { ...current, ...next }
    try { localStorage.setItem('hub-board', JSON.stringify(value)) } catch { /* optional */ }
    return value
  })
  if (query.isPending) return <p className="text-muted-foreground">Loading board...</p>
  if (query.error) return <p className="text-destructive">{query.error.message}</p>
  const response = query.data
  const all = response.data.cards
  const q = search.trim().toLowerCase()
  const cards = q ? all.filter((card) => `${card.key} ${card.title || ''} ${card.project || ''}`.toLowerCase().includes(q)) : all
  const statusGroups = [
    { key: 'active', label: 'Active', empty: 'being worked on' },
    { key: 'review', label: 'Review', empty: 'waiting on a look' },
    { key: 'open', label: 'Queued', empty: 'touched, not started' },
    { key: 'done', label: 'Done', empty: 'finished recently' },
  ]
  const groups = settings.group === 'status' ? statusGroups : [...new Set([
    ...cards.map((card) => card.project || 'elsewhere'),
    ...(response.data.filters.project ? [response.data.filters.project] : []),
  ])].sort().map((project) => ({ key: project, label: project, empty: 'nothing in play here' }))
  const rowsFor = (key: string) => cards.filter((card) => settings.group === 'project'
    ? (card.project || 'elsewhere') === key
    : key === 'open' ? card.statusCategory === 'open' || !card.statusCategory : card.statusCategory === key)
  const totalFor = (key: string) => settings.group === 'project'
    ? response.data.totals.project[key] || 0
    : key === 'open' ? (response.data.totals.status.open || 0) + (response.data.totals.status.unknown || 0) : response.data.totals.status[key] || 0
  return <section>
    <WindowChrome title="Board" response={response} facets={response.data.facets} onDropdown={dropdown} />
    <div className="mb-4 flex flex-wrap items-center gap-3"><Input className="h-8 w-52" type="search" placeholder="Search key or title" value={search} onChange={(event) => setSearch(event.target.value)} /><Segmented label="Board layout" value={settings.layout} options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]} onChange={(value) => remember({ layout: value as BoardLayout })} /><Segmented label="Board grouping" value={settings.group} options={[{ value: 'status', label: 'By status' }, { value: 'project', label: 'By project' }]} onChange={(value) => remember({ group: value as BoardGroup })} /></div>
    {settings.layout === 'cards' ? <div className="grid gap-4 xl:grid-cols-4">{groups.map((group) => { const rows = rowsFor(group.key); const total = totalFor(group.key); return <div key={group.key}><h2 className="mb-2 flex justify-between font-sans font-semibold"><span>{group.label}</span><span>{rows.length}{!response.data.scoped && total > rows.length ? ` of ${total}` : ''}</span></h2><div className="space-y-2">{rows.length ? rows.map((card) => <BoardCardView key={card.key} card={card} />) : <div className="border border-border p-4 text-muted-foreground">{group.empty}</div>}{!response.data.scoped && total > rows.length ? <div className="border border-border p-2 text-center text-muted-foreground">{total - rows.length} more not drawn</div> : null}</div></div> })}</div> : <div className="space-y-5">{groups.map((group) => { const rows = rowsFor(group.key); const total = totalFor(group.key); if (!rows.length) return null; return <section key={group.key}><div className="mb-2 flex items-baseline gap-2"><h2 className="font-sans font-semibold">{group.label}</h2><span className="text-muted-foreground">{rows.length}{!response.data.scoped && total > rows.length ? ` of ${total}` : ''}</span></div><div className="overflow-x-auto border border-border"><Table><TableHeader><TableRow><TableHead>Task</TableHead><TableHead>{settings.group === 'project' ? 'Status' : 'Project'}</TableHead><TableHead>Assignee</TableHead><TableHead>Owner</TableHead><TableHead /></TableRow></TableHeader><TableBody>{rows.map((card) => <TableRow key={card.key}><TableCell><div className="whitespace-nowrap font-semibold">{card.key}</div><div className="font-sans text-sm">{card.title || <span className="text-muted-foreground">no title from its tracker</span>}</div></TableCell><TableCell>{settings.group === 'project' ? card.statusCategory ? <StatusBadge status={card.statusCategory} /> : 'unknown' : card.project || 'elsewhere'}</TableCell><TableCell>{card.assignee || <span className="text-muted-foreground">unknown</span>}</TableCell><TableCell><BoardOwner card={card} /></TableCell><TableCell className="text-right text-live">{card.workingNow ? 'working now' : ''}</TableCell></TableRow>)}</TableBody></Table></div></section> })}</div>}
    <p className="mt-5 text-muted-foreground"><Badge variant="outline">ours</Badge> issued here, yours to change - <Badge variant="outline">mcp</Badge> synced from that project's tracker{response.data.scoped ? ' - counts are for this project' : ''} <button type="button" className="underline" onClick={() => setWhy((open) => !open)}>why these cards?</button></p>
    {why ? <p className="mt-2 max-w-4xl text-muted-foreground">A card is here because it is active, in review, was worked on in the last fortnight, or is ours and still open. Recency comes from recorded work, never from a tracker timestamp: those are bumped on every sync, so everything looks freshly touched. Full backlogs live in each project's own tracker.</p> : null}
  </section>
}
