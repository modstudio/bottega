import { useQuery } from '@tanstack/react-query'
import {
  createRootRoute,
  Link,
  type LinkProps,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router'
import { LogOut } from 'lucide-react'
import { signOutFromRecord } from '@/lib/hosted-auth'
import { isHostedMode, isHostedPath, navForMode } from '@/lib/hub-mode'
import { useWindowState } from '@/lib/window'
import { trpc } from '@/trpc/client'
import { IconButton } from '@/ui/button/button'
import { AppShell, type NavItem, type RenderLink } from '@/ui/shell/app-shell'
import { ThemeToggle } from '@/ui/shell/theme-toggle'
import { Tooltip } from '@/ui/tooltip/tooltip'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

const THEME_KEY = 'hub:theme'
const RAIL_KEY = 'hub:rail'

const mark = (
  <span aria-hidden className="font-mono font-semibold text-lg" data-tone="success">
    <span className="text-status-text">$</span>
  </span>
)

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
    const nav: NavItem[] = navForMode(hosted ? 'hosted' : 'local').map((item) => {
      const counted = 'count' in item ? counts?.[item.count] : undefined
      return {
        to: item.to,
        label: item.label,
        icon: item.icon,
        group: item.group,
        count: counted || undefined,
        live: item.to === '/flight' && Boolean(counts?.flight),
      }
    })
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
        storageKey={RAIL_KEY}
        topbar={
          <>
            <ThemeToggle storageKey={THEME_KEY} />
            {hosted && pathname !== '/sign-in' ? (
              <Tooltip label={email ? `Sign out ${email}` : 'Sign out'}>
                <IconButton label="Sign out" onClick={() => void signOut()}>
                  <LogOut />
                </IconButton>
              </Tooltip>
            ) : null}
          </>
        }
      >
        <div className="mx-auto max-w-[90rem]">
          <Outlet />
        </div>
      </AppShell>
    )
  },
})
