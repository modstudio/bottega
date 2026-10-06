import { useMutation, useQuery } from '@tanstack/react-query'
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
import {
  isDocsPath,
  isHostedMode,
  isHostedPath,
  isHostedSignInFramePath,
  navForMode,
} from '@/lib/hub-mode'
import { waitingInboxEntries } from '@/lib/operator-waiting'
import { useWindowState } from '@/lib/window'
import { queryClient, trpc } from '@/trpc/client'
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

export function HostedSignInFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-surface-page px-4 py-8 text-text-primary">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-3 font-semibold">
          {mark}
          <span>{PLATFORM_NAME}</span>
        </div>
        <div className="border border-border-default bg-surface-raised p-6 shadow-sm sm:p-8">
          {children}
        </div>
      </div>
    </main>
  )
}

/** Rail-free frame for hosted pages that stay reachable signed out, such as docs. */
export function HostedPublicFrame({ children }: { children: React.ReactNode }) {
  return <main className="min-h-dvh bg-surface-page text-text-primary">{children}</main>
}

function identityForMode(hosted: boolean, email: string | null) {
  if (!hosted) return { name: 'Local', detail: 'This machine', canSignOut: false }
  if (!email) return { name: 'Signed out', detail: 'Hosted hub', canSignOut: false }
  return { name: email, detail: 'Hosted hub', canSignOut: true }
}

export function RailFooterIdentity({
  hosted,
  email,
  activeSpaceId = null,
  spaces = [],
  onSelectSpace,
  onSignOut,
}: {
  hosted: boolean
  email: string | null
  activeSpaceId?: string | null
  spaces?: readonly { id: string; name: string }[]
  onSelectSpace?: (spaceId: string) => void
  onSignOut: () => void
}) {
  const identity = identityForMode(hosted, email)
  const activeSpace = spaces.find((space) => space.id === activeSpaceId)
  return (
    <UserMenu
      name={identity.name}
      detail={hosted && activeSpace ? activeSpace.name : identity.detail}
      spaces={hosted ? spaces : []}
      activeSpaceId={activeSpaceId ?? undefined}
      onSelectSpace={hosted ? onSelectSpace : undefined}
      themeKey={THEME_KEY}
      onSignOut={identity.canSignOut ? onSignOut : undefined}
    />
  )
}

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (!isHostedMode()) return
    if (!isHostedPath(location.pathname)) throw redirect({ to: '/runs' })
  },
  component: function Shell() {
    const hosted = isHostedMode()
    const pathname = useRouterState({ select: (state) => state.location.pathname })
    const whoami = useQuery({
      ...trpc.record.whoami.queryOptions(),
      enabled: hosted && !isHostedSignInFramePath(pathname),
      retry: false,
    })
    const signedIn = Boolean(whoami.data?.user && 'email' in whoami.data.user)
    if (hosted && isHostedSignInFramePath(pathname)) {
      return (
        <HostedSignInFrame>
          <Outlet />
        </HostedSignInFrame>
      )
    }
    if (hosted && isDocsPath(pathname) && !signedIn) {
      return <HostedPublicFrame>{whoami.isPending ? null : <Outlet />}</HostedPublicFrame>
    }
    return <AppLayout hosted={hosted} pathname={pathname} />
  },
})

function AppLayout({ hosted, pathname }: { hosted: boolean; pathname: string }) {
  const { counts } = useWindowState()
  const whoami = useQuery({
    ...trpc.record.whoami.queryOptions(),
    enabled: hosted,
    retry: false,
  })
  const waiting = useQuery({
    ...trpc.operator.waiting.queryOptions(undefined, { refetchInterval: 20_000 }),
    enabled: !hosted,
  })
  const switchSpace = useMutation({
    ...trpc.record.setActiveSpace.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      window.location.reload()
    },
  })
  const withCounts = (item: {
    to: string
    label: string
    icon: NavItem['icon']
    count?: 'flight' | 'done' | 'runs' | 'inbox'
  }): NavItem => ({
    to: item.to,
    label: item.label,
    icon: item.icon,
    count:
      item.count === 'inbox'
        ? waitingInboxEntries(waiting.data ?? []).length || undefined
        : (item.count && counts?.[item.count]) || undefined,
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
  const spaces = (whoami.data?.memberships ?? []).flatMap((membership) => {
    const id = membership.space_id
    const name = membership.name
    return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : []
  })
  return (
    <AppShell
      name={PLATFORM_NAME}
      mark={mark}
      nav={nav}
      renderLink={renderLink}
      isActive={isActive}
      storageKey={RAIL_KEY}
      railFooter={
        <RailFooterIdentity
          hosted={hosted}
          email={email}
          activeSpaceId={whoami.data?.activeSpaceId ?? null}
          spaces={spaces}
          onSelectSpace={(spaceId) => switchSpace.mutate({ spaceId })}
          onSignOut={() => void signOut()}
        />
      }
    >
      <div className="mx-auto max-w-[90rem]">
        <Outlet />
      </div>
    </AppShell>
  )
}
