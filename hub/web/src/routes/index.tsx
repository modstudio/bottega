import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TaskView } from '@/components/work-view'
import { isHostedMode } from '@/lib/hub-mode'
import { HomePage } from '@/site/home'
import { siteHead } from '@/site/route'
import { trpc } from '@/trpc/client'

/** The marketing home for a signed-out hosted visitor; the app's own home for everyone else. */
function HostedIndex() {
  // The root shell owns this request and mounts this page only once it has settled. A second
  // fetch from here would reset a failed, dataless query to pending and unmount the page again.
  const whoami = useQuery({ ...trpc.record.whoami.queryOptions(), enabled: false })
  const signedIn = Boolean(whoami.data?.user && 'email' in whoami.data.user)
  return signedIn ? <TaskView name="flight" /> : <HomePage />
}

export const Route = createFileRoute('/')({
  head: () => (isHostedMode() ? siteHead() : {}),
  component: () => (isHostedMode() ? <HostedIndex /> : <TaskView name="flight" />),
})
