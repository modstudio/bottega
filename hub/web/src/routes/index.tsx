import { createFileRoute } from '@tanstack/react-router'
import { TaskView } from '@/components/work-view'
import { isHostedMode } from '@/lib/hub-mode'
import { HomePage } from '@/site/pages'
import { siteHead } from '@/site/route'

export const Route = createFileRoute('/')({
  head: siteHead,
  component: () => (isHostedMode() ? <HomePage /> : <TaskView name="flight" />),
})
