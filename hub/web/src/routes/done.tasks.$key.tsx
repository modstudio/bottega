import { createFileRoute } from '@tanstack/react-router'
import { TaskRoute, taskSearch } from './-task-route'

export const Route = createFileRoute('/done/tasks/$key')({
  validateSearch: taskSearch,
  component: DoneTask,
})

function DoneTask() {
  const { key } = Route.useParams()
  const { id, doc } = Route.useSearch()
  return <TaskRoute taskKey={key} id={id} doc={doc} list="/done" />
}
