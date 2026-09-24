import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TaskSheet } from '@/components/task-sheet'

export const Route = createFileRoute('/board/tasks/$key')({
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === 'string' ? search.id : undefined,
  }),
  component: BoardTask,
})

function BoardTask() {
  const { key } = Route.useParams()
  const { id } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <TaskSheet
      taskKey={key}
      recordId={id}
      onClose={() => void navigate({ to: '/board', resetScroll: false })}
    />
  )
}
