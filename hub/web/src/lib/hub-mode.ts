import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  FolderGit2,
  GitCompareArrows,
  Inbox,
  Kanban,
  type LucideIcon,
  MessageSquareText,
  NotebookPen,
  Palette,
  Plane,
  Play,
  Route as RouteIcon,
  ScanSearch,
  Settings,
  SlidersHorizontal,
  Users,
} from 'lucide-react'

export function isHostedMode() {
  return import.meta.env.VITE_HUB_MODE === 'hosted'
}

export type HostedOrigin =
  | { kind: 'unconfigured' }
  | { kind: 'public'; publicOrigin: string; appOrigin: string }
  | { kind: 'app'; publicOrigin: string; appOrigin: string }

function normalizedOrigin(value: unknown) {
  if (typeof value !== 'string' || !value) return ''
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

/** Classify this page only when both halves of the hosted origin split are configured. */
export function hostedOrigin(
  currentOrigin = typeof window === 'undefined' ? '' : window.location.origin,
  configured = {
    publicOrigin: import.meta.env.VITE_PUBLIC_SITE_ORIGIN,
    appOrigin: import.meta.env.VITE_APP_ORIGIN,
  },
): HostedOrigin {
  const publicOrigin = normalizedOrigin(configured.publicOrigin)
  const appOrigin = normalizedOrigin(configured.appOrigin)
  if (!publicOrigin || !appOrigin) return { kind: 'unconfigured' }
  return currentOrigin === publicOrigin
    ? { kind: 'public', publicOrigin, appOrigin }
    : { kind: 'app', publicOrigin, appOrigin }
}

/**
 * The same path, query and fragment on another origin. The parts are assigned rather than
 * resolved as a relative reference, because a path beginning with two slashes resolves to
 * another host.
 */
export function sameLocationOn(
  origin: string,
  location: { pathname: string; search: string; hash: string },
): string {
  const target = new URL(origin)
  target.pathname = location.pathname
  target.search = location.search
  target.hash = location.hash
  return target.href
}

type Counted = 'flight' | 'done' | 'runs' | 'inbox'
type NavLink = { to: string; label: string; icon: LucideIcon; count?: Counted }
type NavGroup = { label: string; icon: LucideIcon; items: NavLink[] }
export type NavSection = { id: string; entries: (NavLink | NavGroup)[] }

// Pages opened daily stay one click away; the rest sit behind a group that
// opens beside the rail.
const LOCAL_NAV: NavSection[] = [
  {
    id: 'work',
    entries: [
      { to: '/flight', label: 'Flight', icon: Plane, count: 'flight' },
      { to: '/inbox', label: 'Inbox', icon: Inbox, count: 'inbox' },
      { to: '/board', label: 'Board', icon: Kanban },
      { to: '/done', label: 'Done', icon: CheckCircle2, count: 'done' },
      { to: '/runs', label: 'Runs', icon: Play, count: 'runs' },
    ],
  },
  {
    id: 'knowledge',
    entries: [
      { to: '/projects', label: 'Projects', icon: FolderGit2 },
      { to: '/docs', label: 'Docs', icon: BookOpen },
    ],
  },
  {
    id: 'more',
    entries: [
      {
        label: 'Delegation',
        icon: Bot,
        items: [
          { to: '/notes', label: 'Notes', icon: NotebookPen },
          { to: '/messages', label: 'Messages', icon: MessageSquareText },
          { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness },
          { to: '/agents', label: 'Agents', icon: Bot },
          { to: '/routing', label: 'Routing', icon: RouteIcon },
        ],
      },
      {
        label: 'Machine',
        icon: Activity,
        items: [
          { to: '/health', label: 'Health', icon: Activity },
          { to: '/ratio', label: 'Ratio', icon: GitCompareArrows },
          { to: '/spend', label: 'Spend', icon: CircleDollarSign },
        ],
      },
      {
        label: 'Settings',
        icon: Settings,
        items: [
          { to: '/context', label: 'Agent settings', icon: SlidersHorizontal },
          { to: '/settings', label: 'Hub settings', icon: Settings },
          { to: '/design', label: 'Design system', icon: Palette },
        ],
      },
    ],
  },
]

const HOSTED_NAV: NavSection[] = [
  {
    id: 'work',
    entries: [
      { to: '/flight', label: 'Flight', icon: Plane },
      { to: '/board', label: 'Board', icon: Kanban },
      { to: '/done', label: 'Done', icon: CheckCircle2 },
      { to: '/runs', label: 'Runs', icon: Play },
      { to: '/reviews', label: 'Reviews', icon: ScanSearch },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
      { to: '/projects', label: 'Projects', icon: FolderGit2 },
      { to: '/docs', label: 'Docs', icon: BookOpen },
    ],
  },
  {
    id: 'more',
    entries: [
      {
        label: 'Delegation',
        icon: Bot,
        items: [
          { to: '/notes', label: 'Notes', icon: NotebookPen },
          { to: '/messages', label: 'Messages', icon: MessageSquareText },
          { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness },
          { to: '/agents', label: 'Agents', icon: Bot },
          { to: '/routing', label: 'Routing', icon: RouteIcon },
        ],
      },
      {
        label: 'Machine',
        icon: Activity,
        items: [
          { to: '/health', label: 'Health', icon: Activity },
          { to: '/ratio', label: 'Ratio', icon: GitCompareArrows },
          { to: '/spend', label: 'Spend', icon: CircleDollarSign },
        ],
      },
      {
        label: 'Settings',
        icon: Settings,
        items: [
          { to: '/context', label: 'Agent settings', icon: SlidersHorizontal },
          { to: '/settings', label: 'Hub settings', icon: Settings },
          { to: '/members', label: 'Members', icon: Users },
        ],
      },
    ],
  },
]

export function navForMode(mode: 'hosted' | 'local'): NavSection[] {
  return mode === 'hosted' ? HOSTED_NAV : LOCAL_NAV
}

function normalizedPath(pathname: string) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

/** Auth pages that always use the rail-free hosted frame. */
export function isHostedSignInFramePath(pathname: string) {
  const path = normalizedPath(pathname)
  return (
    path === '/sign-in' ||
    path === '/forgot-password' ||
    path === '/reset-password' ||
    path.startsWith('/accept-invitation/') ||
    path.startsWith('/unsubscribe/')
  )
}

export function isDocsPath(pathname: string) {
  const path = normalizedPath(pathname)
  return path === '/docs' || path.startsWith('/docs/')
}

export function isMarketingPath(pathname: string) {
  const path = normalizedPath(pathname)
  return path === '/' || path.startsWith('/product/')
}

export function isHostedPath(pathname: string) {
  const path = normalizedPath(pathname)
  if (isMarketingPath(path)) return true
  if (
    path === '/sign-in' ||
    path === '/forgot-password' ||
    path === '/reset-password' ||
    path === '/flight' ||
    path === '/board' ||
    path === '/done' ||
    path === '/runs' ||
    path === '/reviews' ||
    path === '/reports' ||
    path === '/projects' ||
    path === '/docs' ||
    path === '/context' ||
    path === '/jobs' ||
    path === '/agents' ||
    path === '/routing' ||
    path === '/health' ||
    path === '/notes' ||
    path === '/messages' ||
    path === '/ratio' ||
    path === '/spend' ||
    path === '/settings' ||
    path === '/members'
  ) {
    return true
  }
  if (path.startsWith('/runs/')) return true
  if (path.startsWith('/messages/')) return true
  if (path.startsWith('/flight/tasks/')) return true
  if (path.startsWith('/board/tasks/')) return true
  if (path.startsWith('/done/tasks/')) return true
  if (path.startsWith('/reviews/')) return true
  if (path.startsWith('/accept-invitation/')) return true
  if (path.startsWith('/unsubscribe/')) return true
  if (path.startsWith('/docs/')) return true
  return false
}

export function recordApiUrl() {
  const value = import.meta.env.VITE_RECORD_API_URL
  return typeof value === 'string' && value ? value.replace(/\/$/, '') : ''
}

/**
 * Whether an unauthorized answer should send the visitor to sign in. The public pages are for
 * signed-out visitors: there it is the expected signal that nobody is signed in.
 */
export function unauthorizedLeadsToSignIn(pathname: string, origin: HostedOrigin['kind']) {
  if (origin === 'public') return false
  return !(isHostedSignInFramePath(pathname) || isDocsPath(pathname) || isMarketingPath(pathname))
}
