import { useQuery } from '@tanstack/react-query'
import {
  createRootRoute,
  Link,
  type LinkProps,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router'
import { AppMark } from '@/components/app-mark'
import { signOutFromRecord } from '@/lib/hosted-auth'
import { isHostedMode, isHostedPath, navForMode } from '@/lib/hub-mode'
import { useWindowState } from '@/lib/window'
import { trpc } from '@/trpc/client'
import { AppShell, type NavItem, type NavSection, type RenderLink } from '@/ui/shell/app-shell'
import { UserMenu } from '@/ui/shell/user-menu'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

const THEME_KEY = 'hub:theme'
const RAIL_KEY = 'hub:rail'

const mark = <AppMark className="size-5 shrink-0 text-text-primary" />

const renderLink: RenderLink = (item, { className, onClick, children }) => (
  <Link to={item.to as LinkProps['to']} className={className} onClick={onClick}>
    {children}
  </Link>
)

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (!isHostedMode()) return
    if (!isHostedPath(location.pathname)) throw redirect({ to: '/runs' })
  },
  component: function Shell() {
    const hosted = isHostedMode()
    const { counts } = useWindowState()
    const pathname = useRouterState({ select: (state) => state.location.pathname })
    const whoami = useQuery({
      ...trpc.record.whoami.queryOptions(),
      enabled: hosted && pathname !== '/sign-in',
      retry: false,
    })
    const withCounts = (item: {
      to: string
      label: string
      icon: NavItem['icon']
      count?: 'flight' | 'done' | 'runs'
    }): NavItem => ({
      to: item.to,
      label: item.label,
      icon: item.icon,
      count: (item.count && counts?.[item.count]) || undefined,
      live: item.to === '/flight' && Boolean(counts?.flight),
    })
    const nav: NavSection[] = navForMode(hosted ? 'hosted' : 'local').map((section) => ({
      id: section.id,
      entries: section.entries.map((entry) =>
        'items' in entry ? { ...entry, items: entry.items.map(withCounts) } : withCounts(entry),
      ),
    }))
    const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`)
    const signOut = async () => {
      await signOutFromRecord()
      window.location.assign('/sign-in')
    }
    const email =
      whoami.data?.user && 'email' in whoami.data.user ? String(whoami.data.user.email) : null
    return (
      <AppShell
        name={PLATFORM_NAME}
        mark={mark}
        nav={nav}
        renderLink={renderLink}
        isActive={isActive}
        storageKey={RAIL_KEY}
        railFooter={
          <UserMenu
            name={hosted ? (email ?? 'Signed in') : 'Local'}
            detail={hosted ? 'Hosted hub' : 'This machine'}
            themeKey={THEME_KEY}
            onSignOut={hosted && pathname !== '/sign-in' ? () => void signOut() : undefined}
          />
        }
      >
        <div className="mx-auto max-w-[90rem]">
          <Outlet />
        </div>
      </AppShell>
    )
  },
})
