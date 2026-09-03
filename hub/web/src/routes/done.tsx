import { createFileRoute } from '@tanstack/react-router'
import { TaskView } from '@/components/work-view'

export const Route = createFileRoute('/done')({ component: () => <TaskView name="done" /> })
