import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TaskSheet } from '@/components/task-sheet'

export const Route = createFileRoute('/done/tasks/$key')({ component: DoneTask })

function DoneTask() {
  const { key } = Route.useParams()
  const navigate = useNavigate()
  return <TaskSheet taskKey={key} onClose={() => void navigate({ to: '/done' })} />
}
