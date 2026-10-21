import { createFileRoute } from '@tanstack/react-router'
import { TaskRoute, taskSearch } from './-task-route'

export const Route = createFileRoute('/flight/tasks/$key')({
  validateSearch: taskSearch,
  component: FlightTask,
})

function FlightTask() {
  const { key } = Route.useParams()
  const { id, doc } = Route.useSearch()
  return <TaskRoute taskKey={key} id={id} doc={doc} list="/flight" />
}
