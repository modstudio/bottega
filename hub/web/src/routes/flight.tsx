import { createFileRoute, Outlet } from '@tanstack/react-router'
import { TaskView } from '@/components/work-view'

export const Route = createFileRoute('/flight')({
  component: () => (
    <>
      <TaskView name="flight" />
      <Outlet />
    </>
  ),
})
