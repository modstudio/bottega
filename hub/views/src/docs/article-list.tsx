import type { ReactNode } from 'react'
import { DocTable } from '../markdown/markdown.tsx'
import { articleListStyles } from './article-list.styles.ts'
import type { ArticleListRow } from './article-list-rows.ts'
import { DOC_FORM_LABELS } from './filters.ts'
import type { DocsTreeItem } from './types.ts'

export function ArticleList({
  rows,
  renderLink,
}: {
  rows: readonly ArticleListRow[]
  renderLink: (item: DocsTreeItem, children: ReactNode, className?: string) => ReactNode
}) {
  if (!rows.length) return <div className={articleListStyles().empty()}>No articles yet.</div>
  return (
    <DocTable fit>
      <thead>
        <tr>
          <th>Kind</th>
          <th>Article</th>
          <th>What it covers</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ item, depth, linked }) => (
          <tr key={item.id}>
            <td>{item.form ? DOC_FORM_LABELS[item.form] : ''}</td>
            <td>
              {depth === 1 ? '↳ ' : null}
              {linked ? (
                renderLink(item, depth === 0 ? <strong>{item.title}</strong> : item.title)
              ) : (
                <strong>{item.title}</strong>
              )}
            </td>
            <td>{item.summary ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </DocTable>
  )
}
