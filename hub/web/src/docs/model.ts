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
  return {
    userCount: inAudience(forProject, 'user').length,
    technicalCount: inAudience(forProject, 'technical').length,
    inView: forAudience.length,
    stale,
    offered: offeredFilters(forAudience),
    tree,
    groups,
    selected,
    crumbs: selected ? breadcrumb(selected, path.slice(0, -1)) : [],
    around: selected
      ? neighbors(groups ? groups.flatMap((group) => group.children) : tree, selected.id)
      : { previous: null, next: null },
    headings: doc ? secondLevelHeadings(doc.body) : [],
    subjects: projectSubjects(items),
    active: activeFilterCount(stale),
  }
}
