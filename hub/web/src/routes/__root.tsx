import { useMutation, useQuery } from '@tanstack/react-query'
import {
  createRootRoute,
  HeadContent,
  Link,
  type LinkProps,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppMark } from '@/components/app-mark'
import { signOutFromRecord } from '@/lib/hosted-auth'
import {
  hostedOrigin,
  isDocsPath,
  isHostedMode,
  isHostedPath,
  isHostedSignInFramePath,
  isMarketingPath,
  navForMode,
  sameLocationOn,
} from '@/lib/hub-mode'
import { waitingInboxEntries } from '@/lib/operator-waiting'
import { recordSpaces } from '@/lib/record-spaces'
import { useWindowState } from '@/lib/window'
import { SiteFrame } from '@/site/chrome'
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
  return <div className="min-h-dvh bg-surface-page text-text-primary">{children}</div>
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
    const origin = hostedOrigin()
    if (origin.kind === 'public' && !isPublicSitePath(location.pathname)) {
      navigateToOrigin(origin.appOrigin)
      return
    }
    if (!isHostedPath(location.pathname)) throw redirect({ to: '/runs' })
  },
  component: RootShell,
})

function RootShell() {
  return (
    <>
      <HeadContent />
      <ShellContent />
    </>
  )
}

function ShellContent() {
  const hosted = isHostedMode()
  const origin = hostedOrigin()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const whoami = useQuery({
    ...trpc.record.whoami.queryOptions(),
    enabled: identityQueryEnabled(hosted, pathname, origin.kind),
    retry: false,
  })
  const signedIn = Boolean(whoami.data?.user && 'email' in whoami.data.user)
  if (origin.kind === 'public') {
    return <PublicOriginShell pathname={pathname} appOrigin={origin.appOrigin} />
  }
  if (hosted && isHostedSignInFramePath(pathname)) {
    return (
      <HostedSignInFrame>
        <Outlet />
      </HostedSignInFrame>
    )
  }
  const publicNavigationOrigin = publicOriginForNavigation(
    origin,
    pathname,
    whoami.isFetched,
    signedIn,
  )
  if (publicNavigationOrigin) return <OriginNavigation origin={publicNavigationOrigin} />
  if (hosted && (isMarketingPath(pathname) || (isDocsPath(pathname) && !signedIn))) {
    // Wait for the first answer only. A later refetch of a failed, dataless request reports
    // pending again; unmounting the page for it would remount the observer that refetches.
    if (!whoami.isFetched) return null
    if (pathname === '/' && signedIn) return <AppLayout hosted pathname={pathname} />
    return (
      <HostedPublicFrame>
        <SiteFrame identity={signedIn ? 'signed-in' : 'signed-out'}>
          <Outlet />
        </SiteFrame>
      </HostedPublicFrame>
    )
  }
  return <AppLayout hosted={hosted} pathname={pathname} />
}

function PublicOriginShell({ pathname, appOrigin }: { pathname: string; appOrigin: string }) {
  if (!isPublicSitePath(pathname)) return null
  return (
    <HostedPublicFrame>
      <SiteFrame identity="signed-out" appSignInHref={`${appOrigin}/sign-in`}>
        <Outlet />
      </SiteFrame>
    </HostedPublicFrame>
  )
}

function publicOriginForNavigation(
  origin: ReturnType<typeof hostedOrigin>,
  pathname: string,
  identityFetched: boolean,
  signedIn: boolean,
) {
  if (
    origin.kind === 'app' &&
    (isMarketingPath(pathname) || isDocsPath(pathname)) &&
    identityFetched &&
    !signedIn
  ) {
    return origin.publicOrigin
  }
  return null
}

type OriginKind = ReturnType<typeof hostedOrigin>['kind']

export function identityQueryEnabled(hosted: boolean, pathname: string, origin: OriginKind) {
  return hosted && origin !== 'public' && !isHostedSignInFramePath(pathname)
}

function isPublicSitePath(pathname: string) {
  return isMarketingPath(pathname) || isDocsPath(pathname)
}

function navigateToOrigin(origin: string) {
  window.location.assign(sameLocationOn(origin, window.location))
}

function OriginNavigation({ origin }: { origin: string }) {
  useEffect(() => navigateToOrigin(origin), [origin])
  return null
}

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
  const spaces = recordSpaces(whoami.data?.memberships)
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
