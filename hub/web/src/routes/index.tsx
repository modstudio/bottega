import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TaskView } from '@/components/work-view'
import { isHostedMode } from '@/lib/hub-mode'
import { HomePage } from '@/site/pages'
import { siteHead } from '@/site/route'
import { trpc } from '@/trpc/client'

/** The marketing home for a signed-out hosted visitor; the app's own home for everyone else. */
function HostedIndex() {
  const whoami = useQuery({ ...trpc.record.whoami.queryOptions(), retry: false })
  if (whoami.isPending) return null
  const signedIn = Boolean(whoami.data?.user && 'email' in whoami.data.user)
  return signedIn ? <TaskView name="flight" /> : <HomePage />
}

export const Route = createFileRoute('/')({
  head: () => (isHostedMode() ? siteHead() : {}),
  component: () => (isHostedMode() ? <HostedIndex /> : <TaskView name="flight" />),
})
