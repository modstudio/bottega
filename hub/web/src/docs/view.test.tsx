import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DocsTreeItem } from './types.ts'
import { DocsView } from './view.tsx'

const items: DocsTreeItem[] = [
  {
    id: '1',
    slug: 'getting-started',
    title: 'Getting started',
    parentId: null,
    position: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'bottega',
    audience: 'user',
    delivery: 'demand',
  },
  {
    id: '2',
    slug: 'first-run',
    title: 'Your first run',
    parentId: '1',
    position: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'bottega',
    audience: 'user',
    delivery: 'demand',
  },
  {
    id: '2b',
    slug: 'install',
    title: 'Install',
    parentId: '1',
    position: 1,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'global',
    subject: null,
    audience: 'user',
    delivery: 'inject',
  },
  {
    id: '3',
    slug: 'principles',
    title: 'Principles',
    parentId: null,
    position: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'canon',
    subject: 'bottega',
    audience: 'technical',
    delivery: 'inject',
  },
]

function render(partial: Partial<Parameters<typeof DocsView>[0]> = {}) {
  return renderToStaticMarkup(
    <DocsView
      items={items}
      selectedId="2"
      audience="user"
      onAudience={() => {}}
      project="all"
      onProject={() => {}}
      signedIn
      showProjectChooser
      doc={{
        ...items[1]!,
        body: '## Open a task\n\nEvery piece of work carries a key.\n',
      }}
      onSelect={() => {}}
      searchQuery=""
      onSearchQuery={() => {}}
      searchResults={[]}
      framed={false}
      {...partial}
    />,
  )
}

test('the docs page shows audience tabs, the tree, breadcrumb and previous/next', () => {
  const html = render()
  expect(html).toContain('User guide')
  expect(html).toContain('Technical')
  expect(html).toContain('Getting started')
  expect(html).toContain('Your first run')
  expect(html).toContain('Open a task')
  expect(html).toContain('Docs')
  expect(html).toContain('Install →')
  expect(html).toContain('On this page')
  expect(html).toContain('project / bottega / first-run')
  expect(html).toContain('Search docs')
  expect(html).toContain('Filter')
})

test('signed out hides the technical tab, project chooser and address', () => {
  const html = render({
    signedIn: false,
    showProjectChooser: false,
    audience: 'user',
    framed: true,
  })
  expect(html).toContain('User guide')
  expect(html).not.toContain('Technical')
  expect(html).not.toContain('All projects')
  expect(html).not.toContain('project / bottega / first-run')
})

test('the filter button is absent when documents cannot use a filter', () => {
  const html = render({
    items: items.filter((item) => item.scope === 'project' && item.delivery === 'demand'),
    audience: 'user',
  })
  expect(html).not.toContain('>Filter<')
})
