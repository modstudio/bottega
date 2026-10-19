import { secondLevelHeadings } from '../markdown/headings.ts'
import {
  activeFilterCount,
  applyFilters,
  clearStaleFilters,
  type FilterSelection,
  inProject,
  offeredFilters,
  projectSubjects,
  selectedAudience,
} from './filters.ts'
import {
  breadcrumb,
  groupRootsBySubject,
  neighbors,
  openableItems,
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

/** Articles are the normal reader catalogue; a working-only view remains usable. */
export function docsVisibleByKind(
  items: readonly DocsTreeItem[],
  showWorking: boolean,
): DocsTreeItem[] {
  const hasArticle = items.some((item) => item.kind === 'article')
  if (showWorking || !hasArticle) return [...items]
  return items.filter((item) => item.kind === 'article')
}

/** Whether search follows a working-document view of this catalogue. */
export function docsSearchIncludesWorking(
  items: readonly DocsTreeItem[],
  project: string | 'all',
  showWorking: boolean,
): boolean {
  return docsVisibleByKind(inProject(items, project), showWorking).some(
    (item) => item.kind === 'working',
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
  showWorking = false,
) {
  const projectItems = inProject(items, project)
  const forProject = docsVisibleByKind(projectItems, showWorking)
  const stale = clearStaleFilters(forProject, chosen)
  const structural = applyFilters(forProject, { ...stale, audience: null })
  const tree = treeForAudience(structural, selectedAudience(stale))
  const groups = project === 'all' ? groupRootsBySubject(tree) : null
  const selected = treePath(tree, selectedId ?? '').at(-1) ?? null
  const path = selected ? treePath(tree, selected.id) : []
  const roots = groups ? groups.flatMap((group) => group.children) : tree
  const first = openableItems(roots)[0]
  return {
    first: first ?? null,
    documentCount: openableItems(tree).length,
    inView: forProject.length,
    canShowWorking:
      projectItems.some((item) => item.kind === 'article') &&
      projectItems.some((item) => item.kind === 'working'),
    searchIncludesWorking: docsSearchIncludesWorking(items, project, showWorking),
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
