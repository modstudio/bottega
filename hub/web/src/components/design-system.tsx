import { useQuery } from '@tanstack/react-query'
import { Database, GitCommit, RadioTower } from 'lucide-react'
import type { CSSProperties } from 'react'
import { collectedTime, relativeTime } from '@/lib/format'
import { PROJECT_FALLBACK } from '@/lib/project'
import {
  clearFilters,
  setFilter,
  setHours,
  useWindowState,
  WINDOWS,
  type WindowHours,
} from '@/lib/window'
import { trpc } from '@/trpc/client'
import { Button } from '@/ui/button/button'
import { Select, type SelectOption } from '@/ui/listbox/select'
import { ProjectName } from '@/ui/project-mark/project-mark'
import { Segmented } from '@/ui/segmented/segmented'

export { EmptyState } from '@/ui/empty-state/empty-state'
export { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
export { StatRow, StatTile } from '@/ui/stat/stat'

/** A pulsing dot for work that is running right now. */
export function LiveDot() {
  return (
    <span
      data-tone="success"
      className="relative inline-block size-1.5 shrink-0 rounded-full bg-status-fill motion-safe:animate-pulse"
    >
      <span className="sr-only">Running</span>
    </span>
  )
}

function Filter({
  kind,
  label,
  options,
  onOpenChange,
}: {
  kind: 'project' | 'agent' | 'source'
  label: string
  options: string[]
  onOpenChange?: (open: boolean) => void
}) {
  const { filters } = useWindowState()
  const value = filters[kind]
  // A filter narrows with the window, so the applied value can leave its own
  // option list. It stays selectable and says why, rather than reading "all".
  const choices: SelectOption[] = [
    { value: '', label },
    ...(value && !options.includes(value) ? [{ value, label: value, note: 'no matches' }] : []),
    ...options.map((option) => ({ value: option, label: option })),
  ]
  return (
    <Select
      label={label}
      value={value}
      options={choices}
      onChange={(next) => setFilter(kind, next)}
      onOpenChange={onOpenChange}
    />
  )
}

/** The time window every figure on the page reads; it belongs in the page header. */
export function WindowControl() {
  const state = useWindowState()
  return (
    <Segmented
      label="Time window"
      value={String(state.hours)}
      options={WINDOWS.map((hours) => ({
        value: String(hours),
        label: hours === 168 ? '7d' : hours === 720 ? '30d' : `${hours}h`,
      }))}
      onChange={(value) => setHours(Number(value) as WindowHours)}
    />
  )
}

/**
 * The project, agent and source filters, which narrow a table rather than the
 * page, for a TableCard's filter slot. `active` counts the applied ones.
 */
export function useWindowFilters({
  projects = [],
  agents = [],
  sources,
  onOpenChange,
}: {
  projects?: string[]
  agents?: string[]
  sources?: string[]
  onOpenChange?: (open: boolean) => void
}) {
  const { filters } = useWindowState()
  const active = [filters.project, filters.agent, sources ? filters.source : ''].filter(
    Boolean,
  ).length
  const controls = [
    <Filter
      key="project"
      kind="project"
      label="All projects"
      options={projects}
      onOpenChange={onOpenChange}
    />,
    <Filter
      key="agent"
      kind="agent"
      label="All agents"
      options={agents}
      onOpenChange={onOpenChange}
    />,
    ...(sources
      ? [
          <Filter
            key="source"
            kind="source"
            label="All sources"
            options={sources}
            onOpenChange={onOpenChange}
          />,
        ]
      : []),
    ...(active
      ? [
          <Button key="clear" variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>,
        ]
      : []),
  ]
  return { controls, active }
}

export function responseSubtitle(response: {
  collectedAt: string | null
  activeAgents: string[]
  servingSince: string
}) {
  const agent = `${response.activeAgents.length} agent${response.activeAgents.length === 1 ? '' : 's'} working`
  return {
    text: `${collectedTime(response.collectedAt)} \u00b7 ${agent}`,
    title: `Serving code from ${relativeTime(response.servingSince)}. ${response.activeAgents.length ? response.activeAgents.join(', ') : 'No agent on a task'}`,
  }
}

/**
 * The register's colour for a project, as CSS variables the stylesheet reads.
 *
 * The old dashboard drew a 3px bar in the project's colour beside every project
 * name and down the edge of every board card, and it was the fastest way to
 * tell whose row you were looking at. Colours live in the register
 * (settings.color / settings.colorDark), so the app reads them from the same
 * project list every screen already loads.
 */
export type ProjectColors = Record<string, { light: string | null; dark: string | null }>

export function useProjectColors(enabled = true): ProjectColors {
  const list = useQuery({ ...trpc.project.list.queryOptions(), staleTime: 60_000, enabled })
  const out: Record<string, { light: string | null; dark: string | null }> = {}
  for (const project of list.data ?? []) {
    const settings = project.settings as { color?: string; colorDark?: string }
    out[project.name] = { light: settings.color ?? null, dark: settings.colorDark ?? null }
  }
  return out
}

export function projectVars(
  colors: ReturnType<typeof useProjectColors>,
  name: string | null | undefined,
): CSSProperties | undefined {
  const c = name ? colors[name] : undefined
  if (!c?.light) return undefined
  return { '--pc': c.light, '--pc-dark': c.dark ?? c.light } as CSSProperties
}

/** A project name with its colour bar; "elsewhere" when the row has none. */
export function ProjectMark({
  name,
  colors: suppliedColors,
}: {
  name: string | null | undefined
  colors?: ProjectColors
}) {
  const queriedColors = useProjectColors(!suppliedColors)
  const colors = suppliedColors ?? queriedColors
  const color = name ? colors[name] : undefined
  return (
    <ProjectName name={name || PROJECT_FALLBACK} color={color?.light} colorDark={color?.dark} />
  )
}

export function SourceMark({
  source,
  project,
  protocol,
}: {
  source: string | null | undefined
  project?: string | null
  protocol?: string | null
}) {
  // Source is a glyph, not a colour: project and status colours already carry
  // facts, and a third colour would make two independent facts look like one.
  const title =
    source === 'local'
      ? 'hub'
      : source === 'git'
        ? 'git · derived from history'
        : `${project ?? 'external'} · ${protocol ?? 'tracker protocol unknown'}`
  const Icon = source === 'local' ? Database : source === 'git' ? GitCommit : RadioTower
  return (
    <span className="inline-flex items-center" title={title}>
      <Icon size={13} aria-hidden />
      <span className="sr-only">{title}</span>
    </span>
  )
}
