import { Button } from '@bottega/hub-ui/button'
import { Select, type SelectOption } from '@bottega/hub-ui/listbox/select'
import { Segmented } from '@bottega/hub-ui/segmented'
import {
  clearFilters,
  setFilter,
  setHours,
  useWindowState,
  WINDOWS,
  type WindowHours,
} from '@/lib/window'

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
      size="sm"
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
