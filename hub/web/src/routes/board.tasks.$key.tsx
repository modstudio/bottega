import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TaskSheet } from '@/components/task-sheet'

export const Route = createFileRoute('/board/tasks/$key')({ component: BoardTask })

function BoardTask() {
  const { key } = Route.useParams()
  const navigate = useNavigate()
  return (
    <TaskSheet taskKey={key} onClose={() => void navigate({ to: '/board', resetScroll: false })} />
  )
}
