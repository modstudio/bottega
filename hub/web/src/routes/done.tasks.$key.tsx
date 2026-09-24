import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TaskSheet } from '@/components/task-sheet'

export const Route = createFileRoute('/done/tasks/$key')({
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === 'string' ? search.id : undefined,
  }),
  component: DoneTask,
})

function DoneTask() {
  const { key } = Route.useParams()
  const { id } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <TaskSheet
      taskKey={key}
      recordId={id}
      onClose={() => void navigate({ to: '/done', resetScroll: false })}
    />
  )
}
