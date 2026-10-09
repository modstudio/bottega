import type { DocsAudience, DocsTreeGroup, DocsTreeItem, TreeNode } from './types.ts'

function byPositionThenTitle(a: DocsTreeItem, b: DocsTreeItem) {
  if (a.position !== b.position) return a.position - b.position
  return a.title.localeCompare(b.title)
}

/** True when following parentId from this item would return to it. */
export function parentEdgeCycles(
  item: DocsTreeItem,
  byId: ReadonlyMap<string, DocsTreeItem>,
): boolean {
  const seen = new Set<string>()
  let id = item.parentId
  while (id && byId.has(id)) {
    if (id === item.id) return true
    if (seen.has(id)) return false
    seen.add(id)
    id = byId.get(id)?.parentId ?? null
  }
  return false
}

/**
 * Tree from a flat list. Siblings order by position then title. A missing
 * parent, or a parent edge that would cycle, makes the document a root.
 */
export function buildDocTree(items: readonly DocsTreeItem[]): TreeNode[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const children = new Map<string, DocsTreeItem[]>()
  const roots: DocsTreeItem[] = []
  for (const item of items) {
    const parent = item.parentId && byId.get(item.parentId)
    if (!parent || parentEdgeCycles(item, byId)) {
      roots.push(item)
      continue
    }
    const siblings = children.get(parent.id) ?? []
    siblings.push(item)
    children.set(parent.id, siblings)
  }
  const node = (item: DocsTreeItem): TreeNode => ({
    ...item,
    navigationDisabled: false,
    children: (children.get(item.id) ?? []).slice().sort(byPositionThenTitle).map(node),
  })
  return roots.sort(byPositionThenTitle).map(node)
}

/**
 * Keep audience matches and the ancestors needed to reach them. An ancestor
 * that does not itself match stays in place but cannot be opened.
 */
export function treeForAudience(
  items: readonly DocsTreeItem[],
  audience: DocsAudience | null,
): TreeNode[] {
  const visit = (node: TreeNode): TreeNode | null => {
    const children = node.children.flatMap((child) => {
      const kept = visit(child)
      return kept ? [kept] : []
    })
    const matches = audience === null || node.audiences.includes(audience)
    if (!matches && children.length === 0) return null
    return { ...node, navigationDisabled: !matches, children }
  }
  return buildDocTree(items).flatMap((node) => {
    const kept = visit(node)
    return kept ? [kept] : []
  })
}

export function treePath(nodes: readonly TreeNode[], id: string): DocsTreeItem[] {
  for (const node of nodes) {
    if (node.id === id) {
      const { children: _, ...item } = node
      return [item]
    }
    const nested = treePath(node.children, id)
    if (nested.length) {
      const { children: _, ...item } = node
      return [item, ...nested]
    }
  }
  return []
}

/** The documents a reader can open, in reading order. */
export function openableItems(nodes: readonly TreeNode[]): DocsTreeItem[] {
  const out: DocsTreeItem[] = []
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      const { children, navigationDisabled, ...item } = node
      if (!navigationDisabled) out.push(item)
      walk(children)
    }
  }
  walk(nodes)
  return out
}

export function neighbors(
  nodes: readonly TreeNode[],
  id: string,
): { previous: DocsTreeItem | null; next: DocsTreeItem | null } {
  const order = openableItems(nodes)
  const index = order.findIndex((item) => item.id === id)
  if (index < 0) return { previous: null, next: null }
  return {
    previous: order[index - 1] ?? null,
    next: order[index + 1] ?? null,
  }
}

/**
 * Under All projects, roots sit in project groups, alphabetically, with
 * documents that have no project last under Shared.
 */
export function groupRootsBySubject(roots: readonly TreeNode[]): DocsTreeGroup[] {
  const named = new Map<string, TreeNode[]>()
  const shared: TreeNode[] = []
  for (const root of roots) {
    if (root.projectName) {
      const siblings = named.get(root.projectName) ?? []
      siblings.push(root)
      named.set(root.projectName, siblings)
    } else {
      shared.push(root)
    }
  }
  const groups: DocsTreeGroup[] = [...named.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((heading) => ({ heading, children: named.get(heading)! }))
  if (shared.length) groups.push({ heading: 'Shared', children: shared })
  return groups
}

export type BreadcrumbPart = { key: string; label: string }

/** Docs, then the project when there is one, then ancestor titles — not the document itself. */
export function breadcrumb(
  selected: DocsTreeItem,
  ancestors: readonly DocsTreeItem[],
): BreadcrumbPart[] {
  const parts: BreadcrumbPart[] = [{ key: 'docs', label: 'Docs' }]
  if (selected.projectName) {
    parts.push({ key: `project:${selected.projectName}`, label: selected.projectName })
  }
  for (const ancestor of ancestors) parts.push({ key: ancestor.id, label: ancestor.title })
  return parts
}
