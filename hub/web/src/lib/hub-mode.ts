import {
  Activity,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  FolderGit2,
  GitCompareArrows,
  Kanban,
  type LucideIcon,
  NotebookPen,
  Palette,
  Plane,
  Play,
  Route as RouteIcon,
  ScanSearch,
  Settings,
} from 'lucide-react'

export function isHostedMode() {
  return import.meta.env.VITE_HUB_MODE === 'hosted'
}

type Counted = 'flight' | 'done' | 'runs'
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
        items: [{ to: '/settings', label: 'Hub settings', icon: Settings }],
      },
    ],
  },
]

export function navForMode(mode: 'hosted' | 'local'): NavSection[] {
  return mode === 'hosted' ? HOSTED_NAV : LOCAL_NAV
}

export function isHostedPath(pathname: string) {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (
    path === '/sign-in' ||
    path === '/flight' ||
    path === '/board' ||
    path === '/done' ||
    path === '/runs' ||
    path === '/reviews' ||
    path === '/projects' ||
    path === '/docs' ||
    path === '/jobs' ||
    path === '/agents' ||
    path === '/routing' ||
    path === '/health' ||
    path === '/notes' ||
    path === '/ratio' ||
    path === '/spend' ||
    path === '/settings'
  ) {
    return true
  }
  if (path.startsWith('/runs/')) return true
  if (path.startsWith('/flight/tasks/')) return true
  if (path.startsWith('/board/tasks/')) return true
  if (path.startsWith('/done/tasks/')) return true
  if (path.startsWith('/reviews/')) return true
  if (path.startsWith('/docs/')) return true
  return false
}

export function recordApiUrl() {
  const value = import.meta.env.VITE_RECORD_API_URL
  return typeof value === 'string' && value ? value.replace(/\/$/, '') : ''
}
