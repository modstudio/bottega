import { useQuery } from '@tanstack/react-query'
import { createRootRoute, Link, Outlet, redirect, useRouterState } from '@tanstack/react-router'
import { Button } from '@/components/button'
import { LiveDot } from '@/components/design-system'
import { signOutFromRecord } from '@/lib/hosted-auth'
import { isHostedMode, isHostedPath, navForMode } from '@/lib/hub-mode'
import { useWindowState } from '@/lib/window'
import { trpc } from '@/trpc/client'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (!isHostedMode()) return
    if (!isHostedPath(location.pathname)) throw redirect({ to: '/runs' })
  },
  component: function Shell() {
    const hosted = isHostedMode()
    const nav = navForMode(hosted ? 'hosted' : 'local')
    const { counts } = useWindowState()
    const pathname = useRouterState({ select: (state) => state.location.pathname })
    const whoami = useQuery({
      ...trpc.record.whoami.queryOptions(),
      enabled: hosted && pathname !== '/sign-in',
      retry: false,
    })
    const signOut = async () => {
      await signOutFromRecord()
      window.location.assign('/sign-in')
    }
    return (
      <div className="flex min-h-screen bg-background text-foreground">
        <aside className="w-52 shrink-0 border-r border-border">
          <div className="flex h-14 items-center border-b border-border px-5 font-semibold">
            <span className="mr-2 text-live">$</span>
            {PLATFORM_NAME}
          </div>
          <nav className="space-y-px p-3">
            {nav.map(({ to, label, icon: Icon, ...item }) => (
              <Link
                key={to}
                to={to}
                className="flex items-center gap-3 px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:relative [&.active]:bg-muted [&.active]:font-semibold [&.active]:text-foreground"
              >
                <Icon size={16} strokeWidth={1.5} />
                {label}
                {to === '/flight' && 'count' in item && counts?.flight ? <LiveDot /> : null}
                {'count' in item && counts?.[item.count] ? (
                  <span className="ml-auto text-muted-foreground">{counts[item.count]}</span>
                ) : null}
              </Link>
            ))}
          </nav>
          {hosted && pathname !== '/sign-in' ? (
            <div className="space-y-2 p-3">
              {whoami.data?.user && 'email' in whoami.data.user ? (
                <p className="truncate px-3 text-muted-foreground">
                  {String(whoami.data.user.email)}
                </p>
              ) : null}
              <Button variant="outline" size="sm" className="w-full" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          ) : null}
        </aside>
        <main className="min-w-0 flex-1 px-8 pb-8">
          <div className="max-w-[1160px]">
            <Outlet />
          </div>
        </main>
      </div>
    )
  },
})
