import { useQuery } from '@tanstack/react-query'
import { trpc } from '@/trpc/client'
import type { CSSProperties } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/button'
import { Select, type SelectOption } from '@/components/select'
import { cx } from '@/components/cx'
import { clearFilters, setFilter, setHours, useWindowState, WINDOWS, type WindowHours } from '@/lib/window'
import { collectedTime, relativeTime } from '@/lib/format'

export function PageHeader({ title, subtitle, subtitleTitle, actions }: { title: ReactNode; subtitle?: ReactNode; subtitleTitle?: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div className="min-w-0"><h1>{title}</h1>{subtitle ? <div className="page-subtitle" title={subtitleTitle}>{subtitle}</div> : null}</div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </header>
}

export function SectionTitle({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return <div className="section-title"><h2>{children}</h2>{detail ? <span>{detail}</span> : null}</div>
}

export function StatTile({ figure, label, hint, live }: { figure: ReactNode; label: ReactNode; hint?: ReactNode; live?: boolean }) {
  return <div className="stat-tile"><div className={cx('stat-figure', live && 'text-live')}>{figure}</div><div>{label}</div>{hint ? <div className="meta">{hint}</div> : null}</div>
}

export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('stat-row', className)}>{children}</div>
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return <div className="empty-state"><div>{title}</div><div className="meta mt-1">{hint}</div></div>
}

export function LiveDot() { return <span className="live-dot" aria-label="Running" /> }

function Filter({ kind, label, options, onOpenChange }: { kind: 'project' | 'agent'; label: string; options: string[]; onOpenChange?: (open: boolean) => void }) {
  const { filters } = useWindowState()
  const value = filters[kind]
  // A filter narrows with the window, so the applied value can leave its own
  // option list. It stays selectable and says why, rather than reading "all".
  const choices: SelectOption[] = [
    { value: '', label },
    ...(value && !options.includes(value) ? [{ value, label: value, note: 'no matches' }] : []),
    ...options.map((option) => ({ value: option, label: option })),
  ]
  return <Select label={label} value={value} options={choices} onChange={(next) => setFilter(kind, next)} onOpenChange={onOpenChange} />
}

export function Segmented({ value, options, onChange, label }: { value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>{options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
}

export function WindowBar({ projects = [], agents = [], filters = true, onOpenChange }: { projects?: string[]; agents?: string[]; filters?: boolean; onOpenChange?: (open: boolean) => void }) {
  const state = useWindowState()
  return <div className="window-bar">
    {filters ? <><Filter kind="project" label="All projects" options={projects} onOpenChange={onOpenChange} /><Filter kind="agent" label="All agents" options={agents} onOpenChange={onOpenChange} />{state.filters.project || state.filters.agent ? <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button> : null}</> : null}
    <Segmented label="Time window" value={String(state.hours)} options={WINDOWS.map((hours) => ({ value: String(hours), label: hours === 168 ? '7d' : hours === 720 ? '30d' : `${hours}h` }))} onChange={(value) => setHours(Number(value) as WindowHours)} />
  </div>
}

export function responseSubtitle(response: { collectedAt: string | null; activeAgents: string[]; servingSince: string }) {
  const agent = `${response.activeAgents.length} agent${response.activeAgents.length === 1 ? '' : 's'} working`
  return { text: `${collectedTime(response.collectedAt)} \u00b7 ${agent}`, title: `Serving code from ${relativeTime(response.servingSince)}. ${response.activeAgents.length ? response.activeAgents.join(', ') : 'No agent on a task'}` }
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
export function useProjectColors(): Record<string, { light: string | null; dark: string | null }> {
  const list = useQuery({ ...trpc.project.list.queryOptions(), staleTime: 60_000 })
  const out: Record<string, { light: string | null; dark: string | null }> = {}
  for (const project of list.data ?? []) {
    const settings = project.settings as { color?: string; colorDark?: string }
    out[project.name] = { light: settings.color ?? null, dark: settings.colorDark ?? null }
  }
  return out
}

export function projectVars(colors: ReturnType<typeof useProjectColors>, name: string | null | undefined): CSSProperties | undefined {
  const c = name ? colors[name] : undefined
  if (!c?.light) return undefined
  return { '--pc': c.light, '--pc-dark': c.dark ?? c.light } as CSSProperties
}

/** A project name with its colour bar; "elsewhere" when the row has none. */
export function ProjectMark({ name }: { name: string | null | undefined }) {
  const colors = useProjectColors()
  return <span className="proj" style={projectVars(colors, name)}>{name || 'elsewhere'}</span>
}
