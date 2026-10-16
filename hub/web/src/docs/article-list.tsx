import { Link } from '@tanstack/react-router'
import { DocOverflow } from '@/components/markdown/markdown-overflow'
import type { ArticleListRow } from './article-list.ts'
import { DOC_FORM_LABELS } from './filters.ts'
import type { DocsLocation } from './location.ts'
import type { DocsTreeItem } from './types.ts'

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
          {rows.map(({ item, depth, linked }) => (
            <tr key={item.id}>
              <td>{item.form ? DOC_FORM_LABELS[item.form] : ''}</td>
              <td>
                {depth === 1 ? '↳ ' : null}
                {linked ? (
                  <Link {...locationFor(item)}>
                    {depth === 0 ? <strong>{item.title}</strong> : item.title}
                  </Link>
                ) : (
                  <strong>{item.title}</strong>
                )}
              </td>
              <td>{item.summary ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DocOverflow>
  )
}
