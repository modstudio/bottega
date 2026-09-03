import { createFileRoute } from '@tanstack/react-router'
import { TaskView } from '@/components/work-view'

export const Route = createFileRoute('/')({ component: () => <TaskView name="flight" /> })
