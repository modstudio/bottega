import { createFileRoute } from '@tanstack/react-router'
import { TaskRoute, taskSearch } from './-task-route'

export const Route = createFileRoute('/board/tasks/$key')({
  validateSearch: taskSearch,
  component: BoardTask,
})

function BoardTask() {
  const { key } = Route.useParams()
  const { id, doc } = Route.useSearch()
  return <TaskRoute taskKey={key} id={id} doc={doc} list="/board" />
}
