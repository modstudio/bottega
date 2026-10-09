import {
  activeFilterCount,
  applyFilters,
  clearStaleFilters,
  type FilterSelection,
  inProject,
  offeredFilters,
  projectSubjects,
} from './filters.ts'
import { secondLevelHeadings } from './headings.ts'
import {
  breadcrumb,
  flattenTree,
  groupRootsBySubject,
  neighbors,
  treeForAudience,
  treePath,
} from './tree.ts'
import type { DocsDoc, DocsTreeItem } from './types.ts'

/** The catalogue rows that belong in navigation for the chosen draft visibility. */
export function docsVisibleByStatus(
  items: readonly DocsTreeItem[],
  showDrafts: boolean,
): DocsTreeItem[] {
  return items.filter(
    (item) => item.status === 'current' || (showDrafts && item.status === 'draft'),
  )
}

/** A replacement is linkable only when its address identifies one catalogue row. */
export function resolveDocsReplacement(
  doc: DocsDoc | null,
  items: readonly DocsTreeItem[],
): DocsTreeItem | null {
  if (doc?.status !== 'superseded' || !doc.replacementSlug) return null
  const matches = items.filter(
    (item) =>
      item.scope === doc.scope && item.subject === doc.subject && item.slug === doc.replacementSlug,
  )
  return matches.length === 1 ? matches[0]! : null
}

export function docsViewModel(
  items: readonly DocsTreeItem[],
  project: string | 'all',
  chosen: FilterSelection,
  selectedId: string | null,
  doc: DocsDoc | null,
  includeAudienceFilter = true,
) {
  const forProject = inProject(items, project)
  const stale = clearStaleFilters(forProject, chosen)
  const structural = applyFilters(forProject, { ...stale, audience: null })
  const visible = applyFilters(structural, stale)
  const tree = treeForAudience(structural, stale.audience as 'user' | 'technical' | null)
  const groups = project === 'all' ? groupRootsBySubject(tree) : null
  const selected = treePath(tree, selectedId ?? '').at(-1) ?? null
  const path = selected ? treePath(tree, selected.id) : []
  const roots = groups ? groups.flatMap((group) => group.children) : tree
  const first = flattenTree(roots).find(
    (item) => !(item as DocsTreeItem & { navigationDisabled?: boolean }).navigationDisabled,
  )
  return {
    first: first ?? null,
    documentCount: visible.length,
    inView: visible.length,
    stale,
    offered: offeredFilters(forProject, includeAudienceFilter),
    tree,
    groups,
    selected,
    crumbs: selected ? breadcrumb(selected, path.slice(0, -1)) : [],
    around: selected ? neighbors(roots, selected.id) : { previous: null, next: null },
    headings: doc ? secondLevelHeadings(doc.body) : [],
    subjects: projectSubjects(items),
    active: activeFilterCount(stale),
  }
}
