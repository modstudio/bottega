import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import {
  type BoardCard,
  type BoardGroup,
  type BoardLayout,
  BoardView as BoardPresentation,
  type BoardResponse,
  TaskView as TaskPresentation,
  type TaskResponse,
  type TaskRow,
  type WaitingByRun,
  type WaitingRow,
  type WorkName,
} from '@bottega/hub-views/work-list'
import { WorkStats } from '@bottega/hub-views/work-summary/work-stats'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { useWindowState } from '@/lib/window'
import { useDetailPanel } from '@/routes/-detail-panel'
import { WaitingBadge } from '@/routes/-waiting-badge'
import { useWindowFilters, WindowControl } from '@/routes/-window-controls'
import { WindowChrome } from '@/routes/-work-chrome'

const EMPTY_WAITING_BY_RUN: WaitingByRun = new Map()

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
  const navigate = useNavigate()
  const selectedKey = useParams({ strict: false }).key
  const window = useWindowState()
  const facets = response?.data.facets ?? { projects: [], agents: [], sources: [] }
  const filters = useWindowFilters({ ...facets, onOpenChange: onDropdown })
  const onOpenTask = (row: TaskRow) =>
    void navigate({
      to: name === 'flight' ? '/flight/tasks/$key' : '/done/tasks/$key',
      params: { key: row.spaceId ? `${row.spaceId}:${row.key}` : row.key! },
      search: { id: row.recordId },
      resetScroll: false,
    })
  return (
    <TaskPresentation
      name={name}
      response={response}
      pending={pending}
      error={error}
      fetchedAt={fetchedAt}
      waitingByRun={waitingByRun}
      panel={panel}
      chrome={
        response ? (
          <WindowChrome
            title={name === 'flight' ? 'In flight' : 'Done'}
            response={response}
            facets={facets}
            onDropdown={onDropdown}
          />
        ) : null
      }
      phoneChrome={
        phone && response
          ? { scope: <WindowControl />, summary: <WorkStats response={response} /> }
          : undefined
      }
      filters={filters.controls}
      filtersActive={filters.active}
      filtered={Boolean(window.filters.agent || window.filters.project || window.filters.source)}
      filterAgent={window.filters.agent}
      selectedKey={selectedKey}
      onOpenTask={onOpenTask}
      renderWaiting={(item: WaitingRow) => <WaitingBadge item={item} />}
    />
  )
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
  const panel = useDetailPanel()
  const phone = useMediaQuery(PHONE_QUERY)
  const [settings, setSettings] = useState(readBoardSettings)
  const [search, setSearch] = useState('')
  const [why, setWhy] = useState(false)
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
  const onOpenTask = (card: BoardCard) =>
    void navigate({
      to: '/board/tasks/$key',
      params: { key: card.spaceId ? `${card.spaceId}:${card.key}` : card.key },
      search: { id: card.recordId },
      resetScroll: false,
    })
  return (
    <BoardPresentation
      response={response}
      pending={pending}
      error={error}
      panel={panel}
      onOpenTask={onOpenTask}
      settings={settings}
      search={search}
      onSearchChange={setSearch}
      onSettingsChange={remember}
      why={why}
      onWhyChange={setWhy}
      phone={phone}
      renderChrome={(phoneBand) =>
        response ? (
          <WindowChrome
            title="Board"
            response={response}
            facets={response.data.facets}
            onDropdown={onDropdown}
            headerFilters
            phoneBand={phoneBand}
          />
        ) : null
      }
    />
  )
}
