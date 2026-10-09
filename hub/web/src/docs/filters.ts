import { DOC_AUDIENCES } from '../../../../shared/docs.ts'
import type { DocsAudience, DocsTreeItem } from './types.ts'

export const DOC_AUDIENCE_LABELS: Record<DocsAudience, string> = {
  technical: 'Technical',
  internal: 'Internal',
  customer: 'Customer',
}

export type FilterKey = 'audience' | 'scope' | 'delivery'
export type FilterSelection = Record<FilterKey, string | null>
type FilterOption = { value: string; label: string; count: number }
export type OfferedFilter = { key: FilterKey; allLabel: string; options: FilterOption[] }

/** The audience a selection names, or none when it names no known audience. */
export function selectedAudience(chosen: FilterSelection): DocsAudience | null {
  return DOC_AUDIENCES.find((audience) => audience === chosen.audience) ?? null
}

export const EMPTY_FILTERS: FilterSelection = { audience: null, scope: null, delivery: null }

export function projectSubjects(items: readonly DocsTreeItem[]): string[] {
  const names = new Set<string>()
  for (const item of items) {
    if (item.projectName) names.add(item.projectName)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function inProject(items: readonly DocsTreeItem[], project: string | 'all'): DocsTreeItem[] {
  if (project === 'all') return [...items]
  return items.filter((item) => item.projectName === project)
}

/** Project chooser value for a selected document, or the empty-page default. */
export function chooserProject(
  selected: DocsTreeItem | null,
  subjects: readonly string[],
): string | 'all' {
  if (selected) return selected.projectName ?? 'all'
  return subjects[0] ?? 'all'
}

/** Search sends subject only when the chosen project is a subject for that source. */
export function searchSubject(
  project: string | 'all',
  items: readonly DocsTreeItem[],
): string | undefined {
  if (project === 'all') return undefined
  return items.some((item) => item.subject === project) ? project : undefined
}

function valuesFor(items: readonly DocsTreeItem[], key: FilterKey): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const values =
      key === 'audience' ? item.audiences : [key === 'scope' ? item.scope : item.delivery]
    for (const value of values) {
      if (!value) continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  return counts
}

/** Audience is offered when carried; scope and delivery when documents hold at least two values. */
export function offeredFilters(
  items: readonly DocsTreeItem[],
  includeAudience: boolean,
): OfferedFilter[] {
  const offered: OfferedFilter[] = []
  if (includeAudience) {
    const counts = valuesFor(items, 'audience')
    const options = DOC_AUDIENCES.filter((value) => counts.has(value)).map((value) => ({
      value,
      label: DOC_AUDIENCE_LABELS[value],
      count: counts.get(value)!,
    }))
    if (options.length) offered.push({ key: 'audience', allLabel: 'All audiences', options })
  }
  for (const key of ['scope', 'delivery'] as const) {
    const counts = valuesFor(items, key)
    if (counts.size < 2) continue
    offered.push({
      key,
      allLabel: 'Any',
      options: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, count]) => ({ value, label: value, count })),
    })
  }
  return offered
}

export function clearStaleFilters(
  items: readonly DocsTreeItem[],
  chosen: FilterSelection,
): FilterSelection {
  const next: FilterSelection = { ...chosen }
  for (const key of ['audience', 'scope', 'delivery'] as const) {
    const value = next[key]
    if (!value) continue
    if (key === 'audience') {
      const audience = selectedAudience(next)
      next[key] = audience && valuesFor(items, key).has(audience) ? audience : null
    } else if (!valuesFor(items, key).has(value)) next[key] = null
  }
  return next
}

export function applyFilters(
  items: readonly DocsTreeItem[],
  chosen: FilterSelection,
): DocsTreeItem[] {
  const audience = selectedAudience(chosen)
  return items.filter((item) => {
    if (audience && !item.audiences.includes(audience)) return false
    if (chosen.scope && item.scope !== chosen.scope) return false
    if (chosen.delivery && item.delivery !== chosen.delivery) return false
    return true
  })
}

export function activeFilterCount(chosen: FilterSelection): number {
  return (chosen.audience ? 1 : 0) + (chosen.scope ? 1 : 0) + (chosen.delivery ? 1 : 0)
}
