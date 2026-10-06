import type { DocsAudience, DocsTreeItem } from './types.ts'

export type FilterKey = 'scope' | 'delivery'
export type FilterSelection = Record<FilterKey, string | null>
export type FilterOption = { value: string; count: number }
export type OfferedFilter = { key: FilterKey; options: FilterOption[] }

export const EMPTY_FILTERS: FilterSelection = { scope: null, delivery: null }

export function projectSubjects(items: readonly DocsTreeItem[]): string[] {
  const names = new Set<string>()
  for (const item of items) {
    if (item.subject) names.add(item.subject)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function inProject(items: readonly DocsTreeItem[], project: string | 'all'): DocsTreeItem[] {
  if (project === 'all') return [...items]
  return items.filter((item) => item.subject === project)
}

export function inAudience(items: readonly DocsTreeItem[], audience: DocsAudience): DocsTreeItem[] {
  return items.filter((item) => item.audience === audience)
}

function valuesFor(items: readonly DocsTreeItem[], key: FilterKey): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const value = key === 'scope' ? item.scope : item.delivery
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

/** A filter is offered when the documents in view hold at least two distinct values. */
export function offeredFilters(items: readonly DocsTreeItem[]): OfferedFilter[] {
  const offered: OfferedFilter[] = []
  for (const key of ['scope', 'delivery'] as const) {
    const counts = valuesFor(items, key)
    if (counts.size < 2) continue
    offered.push({
      key,
      options: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, count]) => ({ value, count })),
    })
  }
  return offered
}

export function clearStaleFilters(
  items: readonly DocsTreeItem[],
  chosen: FilterSelection,
): FilterSelection {
  const next: FilterSelection = { ...chosen }
  for (const key of ['scope', 'delivery'] as const) {
    const value = next[key]
    if (!value) continue
    if (!valuesFor(items, key).has(value)) next[key] = null
  }
  return next
}

export function applyFilters(
  items: readonly DocsTreeItem[],
  chosen: FilterSelection,
): DocsTreeItem[] {
  return items.filter((item) => {
    if (chosen.scope && item.scope !== chosen.scope) return false
    if (chosen.delivery && item.delivery !== chosen.delivery) return false
    return true
  })
}

export function activeFilterCount(chosen: FilterSelection): number {
  return (chosen.scope ? 1 : 0) + (chosen.delivery ? 1 : 0)
}
