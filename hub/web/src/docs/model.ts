import {
  activeFilterCount,
  applyFilters,
  clearStaleFilters,
  type FilterSelection,
  inAudience,
  inProject,
  offeredFilters,
  projectSubjects,
} from './filters.ts'
import { secondLevelHeadings } from './headings.ts'
import { breadcrumb, buildDocTree, groupRootsBySubject, neighbors, treePath } from './tree.ts'
import type { DocsAudience, DocsDoc, DocsTreeItem } from './types.ts'

/** The catalogue rows that belong in navigation for the chosen draft visibility. */
export function docsVisibleByStatus(
  items: readonly DocsTreeItem[],
  showDrafts: boolean,
): DocsTreeItem[] {
  return items.filter(
    (item) => item.status === 'current' || (showDrafts && item.status === 'draft'),
  )
}

export function docsViewModel(
  items: readonly DocsTreeItem[],
  audience: DocsAudience,
  project: string | 'all',
  chosen: FilterSelection,
  selectedId: string | null,
  doc: DocsDoc | null,
) {
  const forProject = inProject(items, project)
  const forAudience = inAudience(forProject, audience)
  const stale = clearStaleFilters(forAudience, chosen)
  const visible = applyFilters(forAudience, stale)
  const tree = buildDocTree(visible)
  const groups = project === 'all' ? groupRootsBySubject(tree) : null
  const selected = visible.find((item) => item.id === selectedId) ?? null
  const path = selected ? treePath(tree, selected.id) : []
  const roots = groups ? groups.flatMap((group) => group.children) : tree
  return {
    first: roots[0] ?? null,
    userCount: inAudience(forProject, 'user').length,
    technicalCount: inAudience(forProject, 'technical').length,
    inView: forAudience.length,
    stale,
    offered: offeredFilters(forAudience),
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
