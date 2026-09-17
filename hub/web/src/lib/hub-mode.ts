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

const LOCAL_NAV = [
  { to: '/flight', label: 'Flight', icon: Plane, count: 'flight' },
  { to: '/board', label: 'Board', icon: Kanban },
  { to: '/done', label: 'Done', icon: CheckCircle2, count: 'done' },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/docs', label: 'Docs', icon: BookOpen },
  { to: '/notes', label: 'Notes', icon: NotebookPen },
  { to: '/runs', label: 'Runs', icon: Play, count: 'runs' },
  { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/routing', label: 'Routing', icon: RouteIcon },
  { to: '/health', label: 'Health', icon: Activity },
  { to: '/ratio', label: 'Ratio', icon: GitCompareArrows },
  { to: '/spend', label: 'Spend', icon: CircleDollarSign },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/design', label: 'Design', icon: Palette },
] as const

const HOSTED_NAV = [
  { to: '/runs', label: 'Runs', icon: Play },
  { to: '/reviews', label: 'Reviews', icon: ScanSearch },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/docs', label: 'Docs', icon: BookOpen },
  { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/routing', label: 'Routing', icon: RouteIcon },
  { to: '/health', label: 'Health', icon: Activity },
] as const

export function navForMode(mode: 'hosted' | 'local') {
  return mode === 'hosted' ? HOSTED_NAV : LOCAL_NAV
}

export function isHostedPath(pathname: string) {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (
    path === '/sign-in' ||
    path === '/runs' ||
    path === '/reviews' ||
    path === '/projects' ||
    path === '/docs' ||
    path === '/jobs' ||
    path === '/agents' ||
    path === '/routing' ||
    path === '/health'
  ) {
    return true
  }
  if (path.startsWith('/runs/')) return true
  if (path.startsWith('/reviews/')) return true
  if (path.startsWith('/docs/')) return true
  return false
}

export function recordApiUrl() {
  const value = import.meta.env.VITE_RECORD_API_URL
  return typeof value === 'string' && value ? value.replace(/\/$/, '') : ''
}
