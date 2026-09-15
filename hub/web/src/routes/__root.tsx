import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
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
  Settings,
} from 'lucide-react'
import { LiveDot } from '@/components/design-system'
import { useWindowState } from '@/lib/window'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

const nav = [
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

export const Route = createRootRoute({
  component: function Shell() {
    const { counts } = useWindowState()
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
                {to === '/flight' && counts?.flight ? <LiveDot /> : null}
                {'count' in item && counts?.[item.count] ? (
                  <span className="ml-auto text-muted-foreground">{counts[item.count]}</span>
                ) : null}
              </Link>
            ))}
          </nav>
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
