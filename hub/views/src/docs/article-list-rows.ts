import type { DocsTreeItem, TreeNode } from './types.ts'

export type ArticleListRow = { item: DocsTreeItem; depth: 0 | 1; linked: boolean }

function nodeWithId(nodes: readonly TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const nested = nodeWithId(node.children, id)
    if (nested) return nested
  }
  return null
}

function visibleArticle(node: TreeNode): boolean {
  return !node.navigationDisabled && node.kind === 'article'
}

/** The visible article children and grandchildren of one document, in tree order. */
export function articleListRows(nodes: readonly TreeNode[], docId: string): ArticleListRow[] {
  const subject = nodeWithId(nodes, docId)
  if (!subject) return []
  const rows: ArticleListRow[] = []
  for (const child of subject.children) {
    const grandchildren = child.children.filter(visibleArticle)
    if (visibleArticle(child)) rows.push({ item: child, depth: 0, linked: true })
    else if (child.kind === 'article' && grandchildren.length > 0)
      rows.push({ item: child, depth: 0, linked: false })
    for (const grandchild of grandchildren) rows.push({ item: grandchild, depth: 1, linked: true })
  }
  return rows
}
