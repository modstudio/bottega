import { Badge } from '@bottega/hub-ui/badge'
import { LiveDot } from '@bottega/hub-ui/badge/live-dot'
import { TextButton } from '@bottega/hub-ui/button'
import {
  Collection,
  type CollectionChildRow,
  type CollectionColumn,
} from '@bottega/hub-ui/collection'
import { Docked } from '@bottega/hub-ui/companion'
import { useNow } from '@bottega/hub-ui/dom/clock'
import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { EmptyState } from '@bottega/hub-ui/empty-state'
import { Input } from '@bottega/hub-ui/field/input'
import { Identifier } from '@bottega/hub-ui/identifier'
import { Segmented } from '@bottega/hub-ui/segmented'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@bottega/hub-ui/table'
import { compactTokens, duration, relativeTime, vendorFigures } from '@bottega/hub-util/format'
import { ProjectColorsContext, ProjectMark, projectVars } from '@bottega/hub-views/project-colors'
import { SourceMark } from '@bottega/hub-views/source-mark'
import { taskStatusLook } from '@bottega/hub-views/status-look/task-status'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleDot,
  FolderGit2,
  LayoutGrid,
  Rows3,
} from 'lucide-react'
import { type ReactNode, useContext, useMemo, useState } from 'react'
import { useWindowFilters, WindowControl } from '@/components/design-system'
import { WaitingBadge } from '@/components/waiting-badge'
import { type ChromeResponse, type Facets, WindowChrome, WorkStats } from '@/components/work-chrome'
import { useDetailPanel } from '@/lib/detail-panel'
import { useWindowState } from '@/lib/window'

type WorkName = 'flight' | 'done'
type TaskRun = {
  id: number | string
  root_id?: number | string
  agent: string | null
  job: string | null
  start: string
  ms: number
  running: boolean
  tokens: number
  costUsd: number | null
}
type TaskRow = {
  spaceId?: string
  spaceName?: string
  key: string | null
  recordId?: string
  project: string | null
  title: string | null
  status: string | null
  statusCategory: string | null
  source: string | null
  sourceProtocol: string | null
  engagedMs: number
  engaged: string
  claudeTokens: number
  vendors: { agent: string; tokens: number; costUsd: number | null; runs: number }[]
  workingNow: boolean
  lastAt: number
  runs: TaskRun[]
}
type TaskData = {
  rows: TaskRow[]
  dropped: { reason: string; tasks: number; engaged: string }[]
  unmappedStatuses: { count: number; words: string[] }
  facets: Facets
}
type TaskResponse = ChromeResponse & { data: TaskData }
type Run = TaskRow['runs'][number]
type WaitingRow = { kind: 'question' | 'workflow'; id: number }
type WaitingByRun = ReadonlyMap<string, WaitingRow>
const EMPTY_WAITING_BY_RUN: WaitingByRun = new Map()

type BoardCard = {
  spaceId?: string
  spaceName?: string
  key: string
  recordId?: string
  project: string | null
  title: string | null
  assignee: string | null
  status: string | null
  statusCategory: string | null
  source: string
  sourceProtocol: string | null
  workingNow: boolean
}
type BoardResponse = ChromeResponse & {
  data: {
    cards: BoardCard[]
    totals: { status: Record<string, number>; project: Record<string, number> }
    scoped: boolean
    filters: { project: string; source?: string }
    facets: Facets
  }
}

const compact = compactTokens
const formatMs = duration
const ago = relativeTime
const vendors = (row: TaskRow) => vendorFigures(row.vendors)

function Status({ row }: { row: Pick<TaskRow, 'key' | 'status' | 'statusCategory' | 'source'> }) {
  if (!row.statusCategory) {
    return (
      <span
        className="text-text-muted"
        title={row.key ? 'no tracker reached this task' : undefined}
      >
        {row.key ? 'unknown' : 'no ticket'}
      </span>
    )
  }
  // One tag: the tracker's own word, colored by the hub's category.
  const label = row.source === 'local' ? row.statusCategory : (row.status ?? row.statusCategory)
  return (
    <Badge {...taskStatusLook(row.statusCategory)} title={`Hub status: ${row.statusCategory}`}>
      {label}
    </Badge>
  )
}

/** The task table's columns; `phone` says where each goes when a phone shows the row as a card. */
const columns = [
  {
    id: 'space',
    label: 'Space',
    numeric: false,
    phone: 'line' as const,
    get: (row: TaskRow) => row.spaceName || '',
  },
  {
    id: 'project',
    label: 'Project',
    numeric: false,
    phone: 'line' as const,
    get: (row: TaskRow) => row.project || '',
  },
  {
    id: 'task',
    label: 'Task',
    numeric: false,
    phone: 'title' as const,
    get: (row: TaskRow) => row.key || '',
  },
  {
    id: 'title',
    label: 'Title',
    numeric: false,
    phone: 'title' as const,
    get: (row: TaskRow) => row.title || '',
  },
  {
    id: 'status',
    label: 'Status',
    numeric: false,
    phone: 'aside' as const,
    get: (row: TaskRow) => row.statusCategory || '',
  },
  {
    id: 'updated',
    label: 'Updated',
    numeric: true,
    phone: 'line' as const,
    get: (row: TaskRow) => row.lastAt,
  },
  {
    id: 'engaged',
    label: 'Engaged',
    numeric: true,
    phone: 'line' as const,
    get: (row: TaskRow) => row.engagedMs,
  },
  {
    id: 'claude',
    label: 'Claude',
    numeric: true,
    phone: 'more' as const,
    get: (row: TaskRow) => row.claudeTokens,
  },
  {
    id: 'vendor',
    label: 'Vendor',
    numeric: true,
    phone: 'more' as const,
    get: (row: TaskRow) => row.vendors[0]?.tokens ?? 0,
  },
  {
    id: 'runs',
    label: 'Runs',
    numeric: true,
    phone: 'more' as const,
    get: (row: TaskRow) => row.runs.length,
  },
] as const

type Sort = { col: (typeof columns)[number]['id']; dir: 1 | -1 }

function runCells(run: Run, now: number, waiting: WaitingByRun): CollectionChildRow['cells'] {
  return {
    task: <span className="pl-4">{run.agent ?? '-'}</span>,
    title: <span className="block truncate">{run.job || ''}</span>,
    status: waiting.get(String(run.id)) ? (
      <WaitingBadge item={waiting.get(String(run.id))!} />
    ) : run.running ? (
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

function TaskTitle({ row }: { row: TaskRow }) {
  if (row.title) {
    return (
      <span className="block truncate" title={row.title}>
        {row.title}
      </span>
    )
  }
  return (
    <span className="text-text-muted">
      {row.source === 'git' ? 'title not known, derived from commits' : 'no tracker record yet'}
    </span>
  )
}

function TaskUpdated({ row }: { row: TaskRow }) {
  return (
    <span
      data-tone={row.workingNow ? 'success' : undefined}
      className={row.workingNow ? 'text-status-text' : 'text-text-muted'}
    >
      {row.workingNow ? (
        <>
          <LiveDot /> now
        </>
      ) : (
        ago(row.lastAt)
      )}
    </span>
  )
}

/** One cell of the task table, by column. */
function taskCell(column: Sort['col'], row: TaskRow, now: number, fetchedAt: number): ReactNode {
  const cells: Record<Sort['col'], () => ReactNode> = {
    space: () => row.spaceName,
    project: () => (
      <span className="inline-flex items-center gap-2">
        <ProjectMark name={row.project} />
        <SourceMark source={row.source} project={row.project} protocol={row.sourceProtocol} />
      </span>
    ),
    task: () => (row.key ? <Identifier>{row.key}</Identifier> : null),
    title: () => <TaskTitle row={row} />,
    status: () => <Status row={row} />,
    updated: () => <TaskUpdated row={row} />,
    engaged: () => (
      <strong>
        {row.workingNow ? formatMs(row.engagedMs + Math.max(0, now - fetchedAt)) : row.engaged}
      </strong>
    ),
    claude: () => compact(row.claudeTokens),
    vendor: () => vendors(row),
    runs: () => row.runs.length,
  }
  return cells[column]()
}

/** The task table's columns: sortable headers, and how each field reads on a phone card. */
function taskCollectionColumns(
  sort: Sort,
  changeSort: (col: Sort['col']) => void,
  now: number,
  fetchedAt: number,
): CollectionColumn<TaskRow>[] {
  return columns.slice(0, -1).map((column) => ({
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
    phone: column.phone,
    phoneRender:
      column.id === 'title'
        ? (row: TaskRow) => row.title || 'No title from its tracker'
        : undefined,
    numeric: column.numeric,
    grow: column.id === 'title',
    render: (row) => taskCell(column.id, row, now, fetchedAt),
  }))
}

function TaskTable({
  rows,
  from,
  fetchedAt,
  facets,
  onDropdown,
  panel,
  waitingByRun,
  phoneChrome,
}: {
  rows: TaskRow[]
  from: WorkName
  fetchedAt: number
  facets: Facets
  onDropdown: (open: boolean) => void
  panel?: ReactNode
  waitingByRun: WaitingByRun
  /** On a phone, the window and figures that join the card's band. */
  phoneChrome?: { scope: ReactNode; summary: ReactNode }
}) {
  const navigate = useNavigate()
  const filters = useWindowFilters({ ...facets, onOpenChange: onDropdown })
  const openKey = useParams({ strict: false }).key
  const now = useNow()
  const [sort, setSort] = useState<Sort>({ col: 'updated', dir: -1 })
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.id === sort.col) ?? columns[5]
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
  const collectionColumns = taskCollectionColumns(sort, changeSort, now, fetchedAt)
  return (
    <Collection
      title="Tasks"
      count={sorted.length}
      filters={filters.controls}
      filtersActive={filters.active}
      scope={phoneChrome?.scope}
      summary={phoneChrome?.summary}
      panel={panel}
      selectedKey={openKey}
      columns={collectionColumns}
      rows={sorted}
      getKey={(row) => `${row.spaceId ?? ''}:${row.key}`}
      onOpen={(row) =>
        void navigate({
          to: from === 'flight' ? '/flight/tasks/$key' : '/done/tasks/$key',
          params: { key: row.spaceId ? `${row.spaceId}:${row.key}` : row.key! },
          search: { id: row.recordId },
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
            {isOpen ? 'Hide runs' : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`}
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
          cells: runCells(run, now, waitingByRun),
        }))
      }}
      empty={{ title: 'No tasks.' }}
    />
  )
}

function LooseTable({ rows, fetchedAt }: { rows: TaskRow[]; fetchedAt: number }) {
  const now = useNow()
  return (
    <div className="max-w-3xl overflow-x-auto border border-border-default">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead numeric>Updated</TableHead>
            <TableHead numeric>Engaged</TableHead>
            <TableHead numeric>Claude</TableHead>
            <TableHead numeric>Vendor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.project}>
              <TableCell>
                <ProjectMark name={row.project} />
              </TableCell>
              <TableCell numeric muted>
                {row.workingNow ? 'now' : ago(row.lastAt)}
              </TableCell>
              <TableCell numeric>
                <span className="font-semibold">
                  {row.workingNow
                    ? formatMs(row.engagedMs + Math.max(0, now - fetchedAt))
                    : row.engaged}
                </span>
              </TableCell>
              <TableCell numeric>{compact(row.claudeTokens)}</TableCell>
              <TableCell numeric muted>
                {vendors(row)}
              </TableCell>
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
  waitingByRun,
  phoneChrome,
}: {
  name: WorkName
  data: TaskData
  fetchedAt: number
  onDropdown: (open: boolean) => void
  panel?: ReactNode
  waitingByRun: WaitingByRun
  phoneChrome?: { scope: ReactNode; summary: ReactNode }
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
          waitingByRun={waitingByRun}
          phoneChrome={phoneChrome}
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
            <h2 className="font-semibold">No ticket</h2>
            <span className="text-text-muted">work these projects cannot attribute to a task</span>
          </div>
          <LooseTable rows={loose} fetchedAt={fetchedAt} />
        </section>
      ) : null}
      {data.dropped.length ? (
        <p className="mt-5 max-w-4xl text-text-muted">
          <strong className="text-text-primary">Not shown here:</strong>{' '}
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
        <p className="mt-5 max-w-4xl text-text-muted">
          <strong className="text-text-primary">
            Filtered to tasks {window.filters.agent} worked on.
          </strong>{' '}
          The rows are the whole task: engaged time is still the union of every agent and session on
          it, not {window.filters.agent}'s share.
        </p>
      ) : null}
      {hasRows ? (
        <p className="mt-5 max-w-4xl text-text-muted">
          <strong className="text-text-primary">
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

export function TaskView({
  name,
  response,
  pending,
  error,
  fetchedAt,
  waitingByRun = EMPTY_WAITING_BY_RUN,
  onDropdown,
}: {
  name: WorkName
  response: TaskResponse | undefined
  pending: boolean
  error: string | null
  fetchedAt: number
  waitingByRun?: WaitingByRun
  onDropdown(open: boolean): void
}) {
  const panel = useDetailPanel()
  const phone = useMediaQuery(PHONE_QUERY)
  if (pending) return <p className="text-text-muted">Loading {name}...</p>
  if (error)
    return (
      <p data-tone="error" className="text-status-text">
        {error}
      </p>
    )
  if (!response) return null
  return (
    <section>
      <WindowChrome
        title={name === 'flight' ? 'In flight' : 'Done'}
        response={response}
        facets={response.data.facets}
        onDropdown={onDropdown}
      />
      <TaskContent
        name={name}
        data={response.data}
        fetchedAt={fetchedAt}
        onDropdown={onDropdown}
        panel={panel}
        waitingByRun={waitingByRun}
        phoneChrome={
          phone
            ? { scope: <WindowControl />, summary: <WorkStats response={response} /> }
            : undefined
        }
      />
    </section>
  )
}

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
  const colors = useContext(ProjectColorsContext)
  return (
    <Link
      to="/board/tasks/$key"
      params={{ key: card.spaceId ? `${card.spaceId}:${card.key}` : card.key }}
      search={{ id: card.recordId }}
      resetScroll={false}
      data-record-key={card.key}
      data-project=""
      className="block cursor-pointer border border-border-default border-l-[3px] border-l-project p-3"
      style={projectVars(colors, card.project)}
    >
      <Identifier className="block">{card.key}</Identifier>
      <div className="mt-1 text-xs text-text-muted">{card.spaceName}</div>
      <div className="mt-1 text-sm">
        {card.title || <span className="text-text-muted">No title from its tracker</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <ProjectMark name={card.project} />
        <BoardOwner card={card} />
        <Status row={card} />
        {card.assignee ? <span>{card.assignee}</span> : null}
        {card.workingNow ? (
          <span data-tone="success" className="inline-flex items-center gap-2 text-status-text">
            <LiveDot />
            working now
          </span>
        ) : null}
      </div>
    </Link>
  )
}

/** The board's own search and view controls, beside the window's on a desk or in the band on a phone. */
function boardControls(
  search: string,
  setSearch: (search: string) => void,
  settings: { layout: BoardLayout; group: BoardGroup },
  remember: (next: Partial<{ layout: BoardLayout; group: BoardGroup }>) => void,
) {
  const searchField = (
    <Input
      size="sm"
      type="search"
      aria-label="Search key or title"
      placeholder="Search key or title"
      value={search}
      onChange={(event) => setSearch(event.target.value)}
    />
  )
  const view = (
    <>
      <Segmented
        label="Board layout"
        value={settings.layout}
        options={[
          { value: 'cards', label: 'Cards', icon: LayoutGrid },
          { value: 'table', label: 'Table', icon: Rows3 },
        ]}
        onChange={(value) => remember({ layout: value as BoardLayout })}
      />
      <Segmented
        label="Board grouping"
        value={settings.group}
        options={[
          { value: 'status', label: 'By status', icon: CircleDot },
          { value: 'project', label: 'By project', icon: FolderGit2 },
        ]}
        onChange={(value) => remember({ group: value as BoardGroup })}
      />
    </>
  )
  return { search: searchField, view }
}

export function BoardView({
  response,
  pending,
  error,
  onDropdown,
}: {
  response: BoardResponse | undefined
  pending: boolean
  error: string | null
  onDropdown(open: boolean): void
}) {
  const navigate = useNavigate()
  const boardPanel = useDetailPanel()
  const [settings, setSettings] = useState(readBoardSettings)
  const [search, setSearch] = useState('')
  const [why, setWhy] = useState(false)
  const phone = useMediaQuery(PHONE_QUERY)
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
  if (pending) return <p className="text-text-muted">Loading board...</p>
  if (error)
    return (
      <p data-tone="error" className="text-status-text">
        {error}
      </p>
    )
  if (!response) return null
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
  const { search: boardSearch, view: boardView } = boardControls(
    search,
    setSearch,
    settings,
    remember,
  )
  return (
    <section>
      <WindowChrome
        title="Board"
        response={response}
        facets={response.data.facets}
        onDropdown={onDropdown}
        headerFilters
        phoneBand={{ search: boardSearch, view: boardView }}
      />
      <Docked panel={boardPanel}>
        {phone ? null : (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="w-56 shrink-0">{boardSearch}</div>
            {boardView}
          </div>
        )}
        {settings.layout === 'cards' ? (
          <div className="grid gap-4 xl:grid-cols-4">
            {groups.map((group) => {
              const rows = rowsFor(group.key)
              const total = totalFor(group.key)
              return (
                <div key={group.key}>
                  <h2 className="mb-2 flex justify-between font-semibold">
                    <span>{group.label}</span>
                    <span>
                      {rows.length}
                      {!response.data.scoped && total > rows.length ? ` of ${total}` : ''}
                    </span>
                  </h2>
                  <div className="space-y-2">
                    {rows.length ? (
                      rows.map((card) => (
                        <BoardCardView key={`${card.spaceId ?? ''}:${card.key}`} card={card} />
                      ))
                    ) : (
                      <div className="border border-border-default p-4 text-text-muted">
                        {group.empty}
                      </div>
                    )}
                    {!response.data.scoped && total > rows.length ? (
                      <div className="border border-border-default p-2 text-center text-text-muted">
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
                      id: 'space',
                      label: 'Space',
                      phone: 'line',
                      render: (card) => card.spaceName,
                    },
                    {
                      id: 'task',
                      label: 'Task',
                      phone: 'title',
                      render: (card) => (
                        <>
                          <Identifier className="block">{card.key}</Identifier>
                          <div className="text-sm">
                            {card.title || (
                              <span className="text-text-muted">no title from its tracker</span>
                            )}
                          </div>
                        </>
                      ),
                    },
                    {
                      id: 'group',
                      phone: 'line',
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
                      phone: 'line',
                      render: (card) =>
                        card.assignee || <span className="text-text-muted">unknown</span>,
                    },
                    {
                      id: 'live',
                      label: '',
                      phone: 'aside',
                      render: (card) =>
                        card.workingNow ? (
                          <Badge tone="progress" dot>
                            Working now
                          </Badge>
                        ) : null,
                    },
                  ]}
                  rows={rows}
                  getKey={(card) => `${card.spaceId ?? ''}:${card.key}`}
                  onOpen={(card) =>
                    void navigate({
                      to: '/board/tasks/$key',
                      params: {
                        key: card.spaceId ? `${card.spaceId}:${card.key}` : card.key,
                      },
                      search: { id: card.recordId },
                      resetScroll: false,
                    })
                  }
                  empty={{ title: group.empty }}
                />
              )
            })}
          </div>
        )}
        <p className="mt-5 text-text-muted">
          Source glyphs distinguish hub, external trackers, and git-derived records without using
          state color{response.data.scoped ? ' - counts are for this project' : ''}.{' '}
          <TextButton onClick={() => setWhy((open) => !open)}>why these cards?</TextButton>
        </p>
        {why ? (
          <p className="mt-2 max-w-4xl text-text-muted">
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
