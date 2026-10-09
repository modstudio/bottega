import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { treeForAudience } from './tree.ts'
import { TreeList } from './tree-view.tsx'
import type { DocsTreeItem } from './types.ts'

const rows: DocsTreeItem[] = [
  {
    id: 'parent',
    slug: 'parent',
    title: 'Parent',
    parentId: null,
    position: 0,
    updatedAt: '2026-10-09T00:00:00.000Z',
    scope: 'project',
    subject: 'starship',
    audiences: ['user'],
    status: 'current',
    replacementSlug: null,
  },
  {
    id: 'child',
    slug: 'child',
    title: 'Child',
    parentId: 'parent',
    position: 0,
    updatedAt: '2026-10-09T00:00:00.000Z',
    scope: 'project',
    subject: 'starship',
    audiences: ['technical'],
    status: 'current',
    replacementSlug: null,
  },
]

test('a parent kept only for its children cannot be opened rather than rendered as an open control', () => {
  const html = renderToStaticMarkup(
    <TreeList
      nodes={treeForAudience(rows, 'technical')}
      selectedId="parent"
      collapsed={new Set()}
      onToggle={() => {}}
      onSelect={() => {}}
    />,
  )
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('aria-current="page"')
  expect(html).not.toContain('<button type="button" aria-current="page" title="Parent"')
  expect(html).toContain('<button type="button" title="Child"')
})
