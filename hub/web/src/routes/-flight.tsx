import { waitingByRun } from '@bottega/hub-data/operator-waiting'
import { useOperatorWaiting } from '@bottega/hub-data/use-operator-waiting'
import { useTaskList } from '@bottega/hub-data/use-task-list'
import { useState } from 'react'
import { useWindowState } from '@/lib/window'
import { TaskView } from '@/routes/-work-view'

export function Flight() {
  const window = useWindowState()
  const [menus, setMenus] = useState(0)
  const query = useTaskList('flight', { hours: window.hours, filters: window.filters }, menus > 0)
  const waiting = useOperatorWaiting(true)
  const runs = query.data?.data.rows.flatMap((row) => row.runs) ?? []
  return (
    <TaskView
      name="flight"
      response={query.data}
      pending={query.isPending}
      error={query.error?.message ?? null}
      fetchedAt={query.dataUpdatedAt}
      waitingByRun={waitingByRun(runs, waiting.data ?? [])}
      onDropdown={(open) => setMenus((count) => Math.max(0, count + (open ? 1 : -1)))}
    />
  )
}
