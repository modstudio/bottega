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
import {
  ProjectColorsContext,
  ProjectMark,
  projectVars,
} from '../project-colors/project-colors.tsx'
import { SourceMark } from '../source-mark/source-mark.tsx'
import { taskStatusLook } from '../status-look/task-status.ts'
import type { ChromeResponse } from '../work-summary/work-summary.ts'
import { workListStyles } from './work-list.styles.ts'

export type WorkName = 'flight' | 'done'
type Facets = { projects: string[]; agents: string[]; sources: string[] }
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
export type TaskRow = {
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
export type TaskData = {
  rows: TaskRow[]
  dropped: { reason: string; tasks: number; engaged: string }[]
  unmappedStatuses: { count: number; words: string[] }
  facets: Facets
}
export type TaskResponse = ChromeResponse & { data: TaskData }
type Run = TaskRow['runs'][number]
export type WaitingRow = { kind: 'question' | 'workflow'; id: number }
export type WaitingByRun = ReadonlyMap<string, WaitingRow>

export type BoardCard = {
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
export type BoardResponse = ChromeResponse & {
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
        className={workListStyles().muted()}
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

function runCells(
  run: Run,
  now: number,
  waiting: WaitingByRun,
  renderWaiting: (item: WaitingRow) => ReactNode,
): CollectionChildRow['cells'] {
  return {
    task: <span className={workListStyles().indent()}>{run.agent ?? '-'}</span>,
    title: <span className={workListStyles().truncate()}>{run.job || ''}</span>,
    status: waiting.get(String(run.id)) ? (
      renderWaiting(waiting.get(String(run.id))!)
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
      <span className={workListStyles().truncate()} title={row.title}>
        {row.title}
      </span>
    )
  }
  return (
    <span className={workListStyles().muted()}>
      {row.source === 'git' ? 'title not known, derived from commits' : 'no tracker record yet'}
    </span>
  )
}

function TaskUpdated({ row }: { row: TaskRow }) {
  return (
    <span
      data-tone={row.workingNow ? 'success' : undefined}
      className={workListStyles({ active: row.workingNow }).updated()}
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
      <span className={workListStyles().inlineGap()}>
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
        className={workListStyles().sortButton()}
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
  fetchedAt,
  filters,
  filtersActive,
  empty,
  selectedKey,
  onOpenTask,
  panel,
  waitingByRun,
  renderWaiting,
  phoneChrome,
}: {
  rows: TaskRow[]
  fetchedAt: number
  filters: ReactNode
  filtersActive: number
  empty: { title: string; hint?: string }
  selectedKey?: string
  onOpenTask(row: TaskRow): void
  panel?: ReactNode
  waitingByRun: WaitingByRun
  renderWaiting(item: WaitingRow): ReactNode
  /** On a phone, the window and figures that join the card's band. */
  phoneChrome?: { scope: ReactNode; summary: ReactNode }
}) {
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
      filters={filters}
      filtersActive={filtersActive}
      scope={phoneChrome?.scope}
      summary={phoneChrome?.summary}
      panel={panel}
      selectedKey={selectedKey}
      columns={collectionColumns}
      rows={sorted}
      getKey={(row) => `${row.spaceId ?? ''}:${row.key}`}
      onOpen={onOpenTask}
      rowActions={(row) => {
        const runs = row.runs ?? []
        const isOpen = row.key ? opened.has(row.key) : false
        return runs.length ? (
          <button
            type="button"
            className={workListStyles().inline()}
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
            <ChevronRight className={workListStyles({ open: isOpen }).chevron()} size={13} />
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
          cells: runCells(run, now, waitingByRun, renderWaiting),
        }))
      }}
      empty={empty}
    />
  )
}

function LooseTable({ rows, fetchedAt }: { rows: TaskRow[]; fetchedAt: number }) {
  const now = useNow()
  return (
    <div className={workListStyles().looseTable()}>
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
                <span className={workListStyles().strong()}>
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

export function TaskContent({
  name,
  data,
  fetchedAt,
  filters,
  filtersActive,
  filtered,
  filterAgent,
  selectedKey,
  onOpenTask,
  panel,
  waitingByRun,
  renderWaiting,
  phoneChrome,
}: {
  name: WorkName
  data: TaskData
  fetchedAt: number
  filters: ReactNode
  filtersActive: number
  filtered: boolean
  filterAgent: string
  selectedKey?: string
  onOpenTask(row: TaskRow): void
  panel?: ReactNode
  waitingByRun: WaitingByRun
  renderWaiting(item: WaitingRow): ReactNode
  phoneChrome?: { scope: ReactNode; summary: ReactNode }
}) {
  const tasks = data.rows.filter((row) => row.key)
  const loose = data.rows.filter((row) => !row.key)
  const hasRows = data.rows.length > 0
  return (
    <>
      {/* While filters are active the table stays, because its toolbar is the
          only place the filters can be seen and cleared. */}
      {tasks.length || filtered ? (
        <TaskTable
          rows={tasks}
          fetchedAt={fetchedAt}
          filters={filters}
          filtersActive={filtersActive}
          empty={{
            title: 'No tasks match these filters.',
            hint: 'Clear the filters or widen the window.',
          }}
          selectedKey={selectedKey}
          onOpenTask={onOpenTask}
          panel={panel}
          waitingByRun={waitingByRun}
          renderWaiting={renderWaiting}
          phoneChrome={phoneChrome}
        />
      ) : (
        <EmptyState
          title={
            name === 'flight' ? 'No work is in flight.' : 'No tasks were completed in this window.'
          }
          hint={
            name === 'flight'
              ? 'Work appears here when a task becomes active.'
              : 'Widen the window to see earlier completed work.'
          }
        />
      )}
      {loose.length ? (
        <section className={workListStyles().looseSection()}>
          <div className={workListStyles().looseHead()}>
            <h2 className={workListStyles().strong()}>No ticket</h2>
            <span className={workListStyles().muted()}>
              work these projects cannot attribute to a task
            </span>
          </div>
          <LooseTable rows={loose} fetchedAt={fetchedAt} />
        </section>
      ) : null}
      {data.dropped.length ? (
        <p className={workListStyles().note()}>
          <strong className={workListStyles().primary()}>Not shown here:</strong>{' '}
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
        <div className={workListStyles().notice()}>
          <EmptyState
            title={`${data.unmappedStatuses.count} external tasks with an unmapped status are not shown: ${data.unmappedStatuses.words.join(', ')}`}
            hint="The source words are preserved; hub will not guess their state."
          />
        </div>
      ) : null}
      {tasks.length && filterAgent ? (
        <p className={workListStyles().note()}>
          <strong className={workListStyles().primary()}>
            Filtered to tasks {filterAgent} worked on.
          </strong>{' '}
          The rows are the whole task: engaged time is still the union of every agent and session on
          it, not {filterAgent}'s share.
        </p>
      ) : null}
      {hasRows ? (
        <p className={workListStyles().note()}>
          <strong className={workListStyles().primary()}>
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
  waitingByRun,
  panel,
  chrome,
  phoneChrome,
  filters,
  filtersActive,
  filtered,
  filterAgent,
  selectedKey,
  onOpenTask,
  renderWaiting,
}: {
  name: WorkName
  response: TaskResponse | undefined
  pending: boolean
  error: string | null
  fetchedAt: number
  waitingByRun?: WaitingByRun
  panel?: ReactNode
  chrome: ReactNode
  phoneChrome?: { scope: ReactNode; summary: ReactNode }
  filters: ReactNode
  filtersActive: number
  filtered: boolean
  filterAgent: string
  selectedKey?: string
  onOpenTask(row: TaskRow): void
  renderWaiting(item: WaitingRow): ReactNode
}) {
  if (pending) return <p className={workListStyles().muted()}>Loading {name}...</p>
  if (error)
    return (
      <p data-tone="error" className={workListStyles().status()}>
        {error}
      </p>
    )
  if (!response) return null
  return (
    <section>
      {chrome}
      <TaskContent
        name={name}
        data={response.data}
        fetchedAt={fetchedAt}
        filters={filters}
        filtersActive={filtersActive}
        filtered={filtered}
        filterAgent={filterAgent}
        selectedKey={selectedKey}
        onOpenTask={onOpenTask}
        panel={panel}
        waitingByRun={waitingByRun ?? new Map()}
        renderWaiting={renderWaiting}
        phoneChrome={phoneChrome}
      />
    </section>
  )
}

export type BoardGroup = 'status' | 'project'
export type BoardLayout = 'cards' | 'table'

function BoardOwner({ card }: { card: BoardCard }) {
  return <SourceMark source={card.source} project={card.project} protocol={card.sourceProtocol} />
}

function BoardCardView({ card, onOpen }: { card: BoardCard; onOpen(card: BoardCard): void }) {
  const colors = useContext(ProjectColorsContext)
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      data-record-key={card.key}
      data-project=""
      className={workListStyles().boardCard()}
      style={projectVars(colors, card.project)}
    >
      <Identifier className={workListStyles().block()}>{card.key}</Identifier>
      <div className={workListStyles().spaceName()}>{card.spaceName}</div>
      <div className={workListStyles().cardTitle()}>
        {card.title || <span className={workListStyles().muted()}>No title from its tracker</span>}
      </div>
      <div className={workListStyles().cardMeta()}>
        <ProjectMark name={card.project} />
        <BoardOwner card={card} />
        <Status row={card} />
        {card.assignee ? <span>{card.assignee}</span> : null}
        {card.workingNow ? (
          <span data-tone="success" className={workListStyles().working()}>
            <LiveDot />
            working now
          </span>
        ) : null}
      </div>
    </button>
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
  renderChrome,
  panel,
  onOpenTask,
  settings,
  search,
  onSearchChange,
  onSettingsChange,
  why,
  onWhyChange,
  phone,
}: {
  response: BoardResponse | undefined
  pending: boolean
  error: string | null
  renderChrome(phoneBand: { search: ReactNode; view: ReactNode }): ReactNode
  panel?: ReactNode
  onOpenTask(card: BoardCard): void
  settings: { layout: BoardLayout; group: BoardGroup }
  search: string
  onSearchChange(search: string): void
  onSettingsChange(next: Partial<{ layout: BoardLayout; group: BoardGroup }>): void
  why: boolean
  onWhyChange(open: boolean): void
  phone: boolean
}) {
  if (pending) return <p className={workListStyles().muted()}>Loading board...</p>
  if (error)
    return (
      <p data-tone="error" className={workListStyles().status()}>
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
    onSearchChange,
    settings,
    onSettingsChange,
  )
  return (
    <section>
      {renderChrome({ search: boardSearch, view: boardView })}
      <Docked panel={panel}>
        {phone ? null : (
          <div className={workListStyles().deskControls()}>
            <div className={workListStyles().search()}>{boardSearch}</div>
            {boardView}
          </div>
        )}
        {settings.layout === 'cards' ? (
          <div className={workListStyles().cardGrid()}>
            {groups.map((group) => {
              const rows = rowsFor(group.key)
              const total = totalFor(group.key)
              return (
                <div key={group.key}>
                  <h2 className={workListStyles().groupHead()}>
                    <span>{group.label}</span>
                    <span>
                      {rows.length}
                      {!response.data.scoped && total > rows.length ? ` of ${total}` : ''}
                    </span>
                  </h2>
                  <div className={workListStyles().cardStack()}>
                    {rows.length ? (
                      rows.map((card) => (
                        <BoardCardView
                          key={`${card.spaceId ?? ''}:${card.key}`}
                          card={card}
                          onOpen={onOpenTask}
                        />
                      ))
                    ) : (
                      <div className={workListStyles().empty()}>{group.empty}</div>
                    )}
                    {!response.data.scoped && total > rows.length ? (
                      <div className={workListStyles().remaining()}>
                        {total - rows.length} more not drawn
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className={workListStyles().tableStack()}>
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
                          <Identifier className={workListStyles().block()}>{card.key}</Identifier>
                          <div className={workListStyles().small()}>
                            {card.title || (
                              <span className={workListStyles().muted()}>
                                no title from its tracker
                              </span>
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
                          <span className={workListStyles().inlineGap()}>
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
                        card.assignee || <span className={workListStyles().muted()}>unknown</span>,
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
                  onOpen={onOpenTask}
                  empty={{ title: group.empty }}
                />
              )
            })}
          </div>
        )}
        <p className={workListStyles().boardNote()}>
          Source glyphs distinguish hub, external trackers, and git-derived records without using
          state color{response.data.scoped ? ' - counts are for this project' : ''}.{' '}
          <TextButton onClick={() => onWhyChange(!why)}>why these cards?</TextButton>
        </p>
        {why ? (
          <p className={workListStyles().why()}>
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
