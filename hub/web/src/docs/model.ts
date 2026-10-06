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
import { buildDocTree, neighbors, treePath } from './tree.ts'
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
  const selected = visible.find((item) => item.id === selectedId) ?? null
  return {
    userCount: inAudience(forProject, 'user').length,
    technicalCount: inAudience(forProject, 'technical').length,
    inView: forAudience.length,
    stale,
    offered: offeredFilters(forAudience),
    tree,
    selected,
    crumbs: selected ? treePath(tree, selected.id) : [],
    around: selected ? neighbors(tree, selected.id) : { previous: null, next: null },
    headings: doc ? secondLevelHeadings(doc.body) : [],
    subjects: projectSubjects(items),
    active: activeFilterCount(stale),
  }
}
