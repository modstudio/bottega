import { useBoard } from '@bottega/hub-data/use-board'
import { useWindowState } from '@bottega/hub-data/window'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { BoardView } from '@/routes/-work-view'

export const Route = createFileRoute('/board')({
  component: BoardRoute,
})

function BoardRoute() {
  const window = useWindowState()
  const [menus, setMenus] = useState(0)
  const query = useBoard({ hours: window.hours, filters: window.filters }, menus > 0)
  return (
    <BoardView
      response={query.data}
      pending={query.isPending}
      error={query.error?.message ?? null}
      onDropdown={(open) => setMenus((count) => Math.max(0, count + (open ? 1 : -1)))}
    />
  )
}
