import { Link } from '@tanstack/react-router'
import { DocOverflow } from '@/components/markdown/markdown-overflow'
import { DOC_FORM_LABELS } from './filters.ts'
import type { DocsLocation } from './location.ts'
import type { DocsTreeItem, TreeNode } from './types.ts'

export type ArticleListRow = { item: DocsTreeItem; depth: 0 | 1 }

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
    if (visibleArticle(child)) rows.push({ item: child, depth: 0 })
    for (const grandchild of child.children) {
      if (visibleArticle(grandchild)) rows.push({ item: grandchild, depth: 1 })
    }
  }
  return rows
}

export function ArticleList({
  rows,
  locationFor,
}: {
  rows: readonly ArticleListRow[]
  locationFor: (item: DocsTreeItem) => DocsLocation
}) {
  if (!rows.length) return <div className="mt-3 text-md text-text-muted">No articles yet.</div>
  return (
    <DocOverflow expandLabel="Expand table" title="Table">
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Article</th>
            <th>What it covers</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, depth }) => (
            <tr key={item.id}>
              <td>{item.form ? DOC_FORM_LABELS[item.form] : ''}</td>
              <td>
                {depth === 1 ? '↳ ' : null}
                <Link {...locationFor(item)}>
                  {depth === 0 ? <strong>{item.title}</strong> : item.title}
                </Link>
              </td>
              <td>{item.summary ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DocOverflow>
  )
}
