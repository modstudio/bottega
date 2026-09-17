import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TaskSheet } from '@/components/task-sheet'

export const Route = createFileRoute('/flight/tasks/$key')({ component: FlightTask })

function FlightTask() {
  const { key } = Route.useParams()
  const navigate = useNavigate()
  return (
    <TaskSheet taskKey={key} onClose={() => void navigate({ to: '/flight', resetScroll: false })} />
  )
}
