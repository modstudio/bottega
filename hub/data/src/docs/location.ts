import type { DataTreeItem, DocsSource } from './use-docs.ts'

/** The canonical router target for opening a document from any docs-page control. */
export function docsLocation(item: DataTreeItem, source: DocsSource) {
  return {
    to: '/docs/$scope/$subject/$slug' as const,
    params: {
      scope: item.scope,
      subject: item.subject ?? '_',
      slug: item.slug,
    },
    search: source === 'local' ? {} : { id: item.id },
  }
}
