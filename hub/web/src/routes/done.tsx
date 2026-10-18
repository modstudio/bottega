import { useTaskList } from '@bottega/hub-data/use-task-list'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { TaskView } from '@/components/work-view'
import { useWindowState } from '@/lib/window'

export const Route = createFileRoute('/done')({
  component: DoneRoute,
})

function DoneRoute() {
  const window = useWindowState()
  const [menus, setMenus] = useState(0)
  const query = useTaskList('done', { hours: window.hours, filters: window.filters }, menus > 0)
  return (
    <TaskView
      name="done"
      response={query.data}
      pending={query.isPending}
      error={query.error?.message ?? null}
      fetchedAt={query.dataUpdatedAt}
      onDropdown={(open) => setMenus((count) => Math.max(0, count + (open ? 1 : -1)))}
    />
  )
}
