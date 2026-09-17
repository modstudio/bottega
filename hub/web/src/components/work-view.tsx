import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Collection, type CollectionChildRow, type CollectionColumn } from '@/components/collection'
import {
  EmptyState,
  LiveDot,
  PageHeader,
  ProjectMark,
  projectVars,
  responseSubtitle,
  SourceMark,
  StatRow,
  StatTile,
  useProjectColors,
  useWindowFilters,
  WindowControl,
} from '@/components/design-system'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/table'
import { useNow } from '@/lib/clock'
import { useDetailPanel } from '@/lib/detail-panel'
import { compactTokens, duration, relativeTime, vendorFigures } from '@/lib/format'
import { taskStatusLook } from '@/lib/task-status'
import { setWorkCounts, useWindowState } from '@/lib/window'
import { type BoardResponse, type FlightResponse, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Docked } from '@/ui/companion/companion'
import { Input } from '@/ui/field/input'
import { Identifier } from '@/ui/identifier/identifier'
import { Segmented } from '@/ui/segmented/segmented'

type WorkName = 'flight' | 'done'
type TaskData = FlightResponse['data']
type TaskRow = TaskData['rows'][number]
type Run = TaskRow['runs'][number]
type Facets = { projects: string[]; agents: string[]; sources: string[] }

const number = new Intl.NumberFormat('en-US')

const compact = compactTokens
const formatMs = duration
const ago = relativeTime
const vendors = (row: TaskRow) => vendorFigures(row.vendors)

function Status({ row }: { row: Pick<TaskRow, 'key' | 'status' | 'statusCategory' | 'source'> }) {
  if (!row.statusCategory) {
    return (
      <span
        className="text-muted-foreground"
        title={row.key ? 'no tracker reached this task' : undefined}
      >
        {row.key ? 'unknown' : 'no ticket'}
      </span>
    )
  }
  // One tag: the tracker's own word, coloured by the hub's category.
  const label = row.source === 'local' ? row.statusCategory : (row.status ?? row.statusCategory)
  return (
    <Badge {...taskStatusLook(row.statusCategory)} title={`Hub status: ${row.statusCategory}`}>
      {label}
    </Badge>
  )
}

function WindowChrome({
  title,
  response,
  facets,
  onDropdown,
  headerFilters = false,
}: {
  title: string
  response: Pick<
    FlightResponse,
    'engaged' | 'activeAgents' | 'tasksShipped' | 'collectedAt' | 'servingSince' | 'counts'
  >
  facets: Facets
  onDropdown: (open: boolean) => void
  /** A page without a TableCard shows its filters beside the window instead. */
  headerFilters?: boolean
}) {
  useEffect(() => setWorkCounts(response.counts), [response.counts])
  const filters = useWindowFilters({ ...facets, onOpenChange: onDropdown })
  const subtitle = responseSubtitle(response)
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle.text}
        subtitleTitle={subtitle.title}
        actions={
          <>
            {headerFilters ? filters.controls : null}
            <WindowControl />
          </>
        }
      />
      <StatRow>
        <StatTile
          figure={response.engaged}
          label="Engaged"
          live={response.activeAgents.length > 0}
        />
        <StatTile
          figure={response.activeAgents.length}
          label="Agents working"
          hint={response.activeAgents.join(', ') || 'No agent on a task'}
        />
        <StatTile
          figure={number.format(response.tasksShipped)}
          label="Tasks shipped"
          hint="Last 14 days"
        />
      </StatRow>
    </>
  )
}

const columns = [
  { id: 'project', label: 'Project', numeric: false, get: (row: TaskRow) => row.project || '' },
  { id: 'task', label: 'Task', numeric: false, get: (row: TaskRow) => row.key || '' },
  { id: 'title', label: 'Title', numeric: false, get: (row: TaskRow) => row.title || '' },
  {
    id: 'status',
    label: 'Status',
    numeric: false,
    get: (row: TaskRow) => row.statusCategory || '',
  },
  { id: 'updated', label: 'Updated', numeric: true, get: (row: TaskRow) => row.lastAt },
  { id: 'engaged', label: 'Engaged', numeric: true, get: (row: TaskRow) => row.engagedMs },
  { id: 'claude', label: 'Claude', numeric: true, get: (row: TaskRow) => row.claudeTokens },
  {
    id: 'vendor',
    label: 'Vendor',
    numeric: true,
    get: (row: TaskRow) => row.vendors[0]?.tokens ?? 0,
  },
  { id: 'runs', label: 'Runs', numeric: true, get: (row: TaskRow) => row.runs.length },
] as const

type Sort = { col: (typeof columns)[number]['id']; dir: 1 | -1 }

function runCells(run: Run, now: number): CollectionChildRow['cells'] {
  return {
    task: <span className="pl-4">{run.agent ?? '-'}</span>,
    title: <span className="block truncate">{run.job || ''}</span>,
    status: run.running ? (
      <Badge tone="progress" dot>
        Running
      </Badge>
    ) : (
      <Badge icon={false}>Done</Badge>
    ),
    engaged: formatMs(run.running ? now - new Date(run.start).getTime() : run.ms),
    vendor: `${compact(run.tokens)}${run.costUsd != null ? ` $${run.costUsd.toFixed(2)}` : ''}`,
  }
}

function TaskTable({
  rows,
  from,
  fetchedAt,
  facets,
  onDropdown,
  panel,
}: {
  rows: TaskRow[]
  from: WorkName
  fetchedAt: number
  facets: Facets
  onDropdown: (open: boolean) => void
  panel?: ReactNode
}) {
  const navigate = useNavigate()
  const filters = useWindowFilters({ ...facets, onOpenChange: onDropdown })
  const openKey = useParams({ strict: false }).key
  const now = useNow()
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
  const changeSort = (col: Sort['col']) =>
    setSort((current) =>
      current.col === col ? { col, dir: current.dir === -1 ? 1 : -1 } : { col, dir: -1 },
    )
  const collectionColumns: CollectionColumn<TaskRow>[] = columns.slice(0, -1).map((column) => ({
    id: column.id,
    label: (
      <button
        type="button"
        className="inline-flex items-center gap-1 whitespace-nowrap"
        onClick={() => changeSort(column.id)}
      >
        {column.label}
        {sort.col === column.id ? (
          sort.dir < 0 ? (
            <ArrowDown size={12} aria-label="descending" />
          ) : (
            <ArrowUp size={12} aria-label="ascending" />
          )
        ) : null}
      </button>
    ),
    priority: column.id === 'claude' || column.id === 'vendor' ? ('low' as const) : undefined,
    numeric: column.numeric,
    grow: column.id === 'title',
    render: (row) =>
      column.id === 'project' ? (
        <span className="inline-flex items-center gap-2">
          <ProjectMark name={row.project} />
          <SourceMark source={row.source} project={row.project} protocol={row.sourceProtocol} />
        </span>
      ) : column.id === 'task' ? (
        row.key ? (
          <Identifier>{row.key}</Identifier>
        ) : null
      ) : column.id === 'title' ? (
        row.title ? (
          <span className="block truncate" title={row.title}>
            {row.title}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {row.source === 'git'
              ? 'title not known, derived from commits'
              : 'no tracker record yet'}
          </span>
        )
      ) : column.id === 'status' ? (
        <Status row={row} />
      ) : column.id === 'updated' ? (
        <span className={row.workingNow ? 'text-live' : 'text-muted-foreground'}>
          {row.workingNow ? (
            <>
              <LiveDot /> now
            </>
          ) : (
            ago(row.lastAt)
          )}
        </span>
      ) : column.id === 'engaged' ? (
        <strong>
          {row.workingNow ? formatMs(row.engagedMs + Math.max(0, now - fetchedAt)) : row.engaged}
        </strong>
      ) : column.id === 'claude' ? (
        compact(row.claudeTokens)
      ) : (
        vendors(row)
      ),
  }))
  return (
    <Collection
      title="Tasks"
      count={sorted.length}
      filters={filters.controls}
      filtersActive={filters.active}
      panel={panel}
      selectedKey={openKey}
      columns={collectionColumns}
      rows={sorted}
      getKey={(row) => row.key!}
      onOpen={(row) =>
        void navigate({
          to: from === 'flight' ? '/flight/tasks/$key' : '/done/tasks/$key',
          params: { key: row.key! },
          resetScroll: false,
        })
      }
      rowActions={(row) => {
        const runs = row.runs ?? []
        const isOpen = row.key ? opened.has(row.key) : false
        return runs.length ? (
          <button
            type="button"
            className="inline-flex items-center"
            onClick={() =>
              row.key &&
              setOpened((current) => {
                const next = new Set(current)
                if (next.has(row.key!)) next.delete(row.key!)
                else next.add(row.key!)
                return next
              })
            }
          >
            {isOpen ? 'hide' : runs.length}
            <ChevronRight className={isOpen ? 'rotate-90' : ''} size={13} />
          </button>
        ) : (
          '-'
        )
      }}
      childRows={(row) => {
        const runs = row.runs ?? []
        const visible = row.key && opened.has(row.key) ? runs : runs.filter((run) => run.running)
        return visible.map((run) => ({
          key: `${run.start}:${run.agent}:${run.job}`,
          cells: runCells(run, now),
        }))
      }}
      empty={{ title: 'No tasks.' }}
    />
  )
}

function LooseTable({ rows, fetchedAt }: { rows: TaskRow[]; fetchedAt: number }) {
  const now = useNow()
  return (
    <div className="max-w-3xl overflow-x-auto border border-border">
      <Table className="text-[12px]">
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead className="text-right">Updated</TableHead>
            <TableHead className="text-right">Engaged</TableHead>
            <TableHead className="text-right">Claude</TableHead>
            <TableHead className="text-right">Vendor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.project}>
              <TableCell>
                <ProjectMark name={row.project} />
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                {row.workingNow ? 'now' : ago(row.lastAt)}
              </TableCell>
              <TableCell className="text-right font-semibold">
                {row.workingNow
                  ? formatMs(row.engagedMs + Math.max(0, now - fetchedAt))
                  : row.engaged}
              </TableCell>
              <TableCell className="text-right">{compact(row.claudeTokens)}</TableCell>
              <TableCell className="text-right text-muted-foreground">{vendors(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function TaskContent({
  name,
  data,
  fetchedAt,
  onDropdown,
  panel,
}: {
  name: WorkName
  data: TaskData
  fetchedAt: number
  onDropdown: (open: boolean) => void
  panel?: ReactNode
}) {
  const window = useWindowState()
  const tasks = data.rows.filter((row) => row.key)
  const loose = data.rows.filter((row) => !row.key)
  const filtered = Boolean(window.filters.agent || window.filters.project || window.filters.source)
  const hasRows = data.rows.length > 0
  return (
    <>
      {tasks.length ? (
        <TaskTable
          rows={tasks}
          from={name}
          fetchedAt={fetchedAt}
          facets={data.facets}
          onDropdown={onDropdown}
          panel={panel}
        />
      ) : (
        <EmptyState
          title={
            filtered
              ? 'No tasks match these filters.'
              : name === 'flight'
                ? 'No work is in flight.'
                : 'No tasks were completed in this window.'
          }
          hint={
            filtered
              ? 'Clear the filters or widen the window.'
              : name === 'flight'
                ? 'Work appears here when a task becomes active.'
                : 'Widen the window to see earlier completed work.'
          }
        />
      )}
      {loose.length ? (
        <section className="mt-7">
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="font-sans font-semibold">No ticket</h2>
            <span className="text-muted-foreground">
              work these projects cannot attribute to a task
            </span>
          </div>
          <LooseTable rows={loose} fetchedAt={fetchedAt} />
        </section>
      ) : null}
      {data.dropped.length ? (
        <p className="mt-5 max-w-4xl text-muted-foreground">
          <strong className="text-foreground">Not shown here:</strong>{' '}
          {data.dropped
            .map(
              (item) =>
                `${item.tasks} task${item.tasks === 1 ? '' : 's'} (${item.engaged}) ${item.reason}`,
            )
            .join('; ')}
          . In flight means being worked on right now, or marked active in its tracker.
        </p>
      ) : null}
      {data.unmappedStatuses.count ? (
        <div className="mt-5 max-w-4xl">
          <EmptyState
            title={`${data.unmappedStatuses.count} external tasks with an unmapped status are not shown: ${data.unmappedStatuses.words.join(', ')}`}
            hint="The source words are preserved; hub will not guess their state."
          />
        </div>
      ) : null}
      {tasks.length && window.filters.agent ? (
        <p className="mt-5 max-w-4xl text-muted-foreground">
          <strong className="text-foreground">
            Filtered to tasks {window.filters.agent} worked on.
          </strong>{' '}
          The rows are the whole task: engaged time is still the union of every agent and session on
          it, not {window.filters.agent}'s share.
        </p>
      ) : null}
      {hasRows ? (
        <p className="mt-5 max-w-4xl text-muted-foreground">
          <strong className="text-foreground">
            Engaged time is the union of every agent's spans, never their sum.
          </strong>{' '}
          A session waiting on a delegated agent is not idle, and two agents at once did not take
          twice as long. That is why the estate total above is smaller than these rows added
          together.
        </p>
      ) : null}
    </>
  )
}

export function TaskView({ name }: { name: WorkName }) {
  const window = useWindowState()
  const [menus, setMenus] = useState(0)
  const options =
    name === 'flight'
      ? trpc.work.flight.queryOptions({ hours: window.hours, filters: window.filters })
      : trpc.work.done.queryOptions({ hours: window.hours, filters: window.filters })
  // Keep the last result on screen while a new filter or window loads: a pending
  // state here unmounts the toolbar, which destroys the control being used.
  const query = useQuery({
    ...options,
    placeholderData: keepPreviousData,
    refetchInterval: menus ? false : 10_000,
  })
  const dropdown = (open: boolean) => setMenus((count) => Math.max(0, count + (open ? 1 : -1)))
  const panel = useDetailPanel()
  if (query.isPending) return <p className="text-muted-foreground">Loading {name}...</p>
  if (query.error) return <p className="text-destructive">{query.error.message}</p>
  return (
    <section>
      <WindowChrome
        title={name === 'flight' ? 'In flight' : 'Done'}
        response={query.data}
        facets={query.data.data.facets}
        onDropdown={dropdown}
      />
      <TaskContent
        name={name}
        data={query.data.data}
        fetchedAt={query.dataUpdatedAt}
        onDropdown={dropdown}
        panel={panel}
      />
    </section>
  )
}

type BoardCard = BoardResponse['data']['cards'][number]
type BoardGroup = 'status' | 'project'
type BoardLayout = 'cards' | 'table'

function readBoardSettings(): { layout: BoardLayout; group: BoardGroup } {
  try {
    const saved = JSON.parse(localStorage.getItem('hub-board') || '{}') as Record<string, unknown>
    return {
      layout: saved.layout === 'table' ? 'table' : 'cards',
      group: saved.group === 'project' ? 'project' : 'status',
    }
  } catch {
    return { layout: 'cards', group: 'status' }
  }
}

function BoardOwner({ card }: { card: BoardCard }) {
  return <SourceMark source={card.source} project={card.project} protocol={card.sourceProtocol} />
}

function BoardCardView({ card }: { card: BoardCard }) {
  const colors = useProjectColors()
  return (
    <Link
      to="/board/tasks/$key"
      params={{ key: card.key }}
      resetScroll={false}
      data-record-key={card.key}
      className="proj-card block cursor-pointer border border-border p-3 focus-visible:ring-2 focus-visible:ring-ring"
      style={projectVars(colors, card.project)}
    >
      <Identifier className="block">{card.key}</Identifier>
      <div className="mt-1 font-sans text-[12.5px]">
        {card.title || <span className="text-muted-foreground">No title from its tracker</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        <ProjectMark name={card.project} />
        <BoardOwner card={card} />
        <Status row={card} />
        {card.assignee ? <span>{card.assignee}</span> : null}
        {card.workingNow ? (
          <span className="inline-flex items-center gap-2 text-live">
            <LiveDot />
            working now
          </span>
        ) : null}
      </div>
    </Link>
  )
}

export function BoardView() {
  const navigate = useNavigate()
  const boardPanel = useDetailPanel()
  const window = useWindowState()
  const [menus, setMenus] = useState(0)
  const [settings, setSettings] = useState(readBoardSettings)
  const [search, setSearch] = useState('')
  const [why, setWhy] = useState(false)
  const query = useQuery({
    ...trpc.work.board.queryOptions({ hours: window.hours, filters: window.filters }),
    placeholderData: keepPreviousData,
    refetchInterval: menus ? false : 10_000,
  })
  const dropdown = (open: boolean) => setMenus((count) => Math.max(0, count + (open ? 1 : -1)))
  const remember = (next: Partial<typeof settings>) =>
    setSettings((current) => {
      const value = { ...current, ...next }
      try {
        localStorage.setItem('hub-board', JSON.stringify(value))
      } catch {
        /* optional */
      }
      return value
    })
  if (query.isPending) return <p className="text-muted-foreground">Loading board...</p>
  if (query.error) return <p className="text-destructive">{query.error.message}</p>
  const response = query.data
  const all = response.data.cards
  const q = search.trim().toLowerCase()
  const cards = q
    ? all.filter((card) =>
        `${card.key} ${card.title || ''} ${card.project || ''}`.toLowerCase().includes(q),
      )
    : all
  const statusGroups = [
    { key: 'active', label: 'Active', empty: 'being worked on' },
    { key: 'review', label: 'Review', empty: 'waiting on a look' },
    { key: 'open', label: 'Queued', empty: 'touched, not started' },
    { key: 'done', label: 'Done', empty: 'finished recently' },
  ]
  const groups =
    settings.group === 'status'
      ? statusGroups
      : [
          ...new Set([
            ...cards.map((card) => card.project || 'elsewhere'),
            ...(response.data.filters.project ? [response.data.filters.project] : []),
          ]),
        ]
          .sort()
          .map((project) => ({ key: project, label: project, empty: 'nothing in play here' }))
  const rowsFor = (key: string) =>
    cards.filter((card) =>
      settings.group === 'project'
        ? (card.project || 'elsewhere') === key
        : key === 'open'
          ? card.statusCategory === 'open' || !card.statusCategory
          : card.statusCategory === key,
    )
  const totalFor = (key: string) =>
    settings.group === 'project'
      ? response.data.totals.project[key] || 0
      : key === 'open'
        ? (response.data.totals.status.open || 0) + (response.data.totals.status.unknown || 0)
        : response.data.totals.status[key] || 0
  return (
    <section>
      <WindowChrome
        title="Board"
        response={response}
        facets={response.data.facets}
        onDropdown={dropdown}
        headerFilters
      />
      <Docked panel={boardPanel}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Input
            className="h-8 w-52"
            type="search"
            placeholder="Search key or title"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Segmented
            label="Board layout"
            value={settings.layout}
            options={[
              { value: 'cards', label: 'Cards' },
              { value: 'table', label: 'Table' },
            ]}
            onChange={(value) => remember({ layout: value as BoardLayout })}
          />
          <Segmented
            label="Board grouping"
            value={settings.group}
            options={[
              { value: 'status', label: 'By status' },
              { value: 'project', label: 'By project' },
            ]}
            onChange={(value) => remember({ group: value as BoardGroup })}
          />
        </div>
        {settings.layout === 'cards' ? (
          <div className="grid gap-4 xl:grid-cols-4">
            {groups.map((group) => {
              const rows = rowsFor(group.key)
              const total = totalFor(group.key)
              return (
                <div key={group.key}>
                  <h2 className="mb-2 flex justify-between font-sans font-semibold">
                    <span>{group.label}</span>
                    <span>
                      {rows.length}
                      {!response.data.scoped && total > rows.length ? ` of ${total}` : ''}
                    </span>
                  </h2>
                  <div className="space-y-2">
                    {rows.length ? (
                      rows.map((card) => <BoardCardView key={card.key} card={card} />)
                    ) : (
                      <div className="border border-border p-4 text-muted-foreground">
                        {group.empty}
                      </div>
                    )}
                    {!response.data.scoped && total > rows.length ? (
                      <div className="border border-border p-2 text-center text-muted-foreground">
                        {total - rows.length} more not drawn
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map((group) => {
              const rows = rowsFor(group.key)
              if (!rows.length) return null
              return (
                <Collection
                  key={group.key}
                  title={group.label}
                  count={rows.length}
                  columns={[
                    {
                      id: 'task',
                      label: 'Task',
                      render: (card) => (
                        <>
                          <Identifier className="block">{card.key}</Identifier>
                          <div className="font-sans text-sm">
                            {card.title || (
                              <span className="text-muted-foreground">
                                no title from its tracker
                              </span>
                            )}
                          </div>
                        </>
                      ),
                    },
                    {
                      id: 'group',
                      label: settings.group === 'project' ? 'Status' : 'Project',
                      render: (card) =>
                        settings.group === 'project' ? (
                          <Status row={card} />
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <ProjectMark name={card.project} />
                            <BoardOwner card={card} />
                          </span>
                        ),
                    },
                    {
                      id: 'assignee',
                      label: 'Assignee',
                      render: (card) =>
                        card.assignee || <span className="text-muted-foreground">unknown</span>,
                    },
                    {
                      id: 'live',
                      label: '',
                      render: (card) =>
                        card.workingNow ? (
                          <Badge tone="progress" dot>
                            Working now
                          </Badge>
                        ) : null,
                    },
                  ]}
                  rows={rows}
                  getKey={(card) => card.key}
                  onOpen={(card) =>
                    void navigate({
                      to: '/board/tasks/$key',
                      params: { key: card.key },
                      resetScroll: false,
                    })
                  }
                  empty={{ title: group.empty }}
                />
              )
            })}
          </div>
        )}
        <p className="mt-5 text-muted-foreground">
          Source glyphs distinguish hub, external trackers, and git-derived records without using
          state colour{response.data.scoped ? ' - counts are for this project' : ''}.{' '}
          <button type="button" className="underline" onClick={() => setWhy((open) => !open)}>
            why these cards?
          </button>
        </p>
        {why ? (
          <p className="mt-2 max-w-4xl text-muted-foreground">
            A card is here because it is active, in review, was worked on in the last fortnight, or
            is ours and still open. Recency comes from recorded work, never from a tracker
            timestamp: those are bumped on every sync, so everything looks freshly touched. Full
            backlogs live in each project's own tracker.
          </p>
        ) : null}
      </Docked>
    </section>
  )
}
