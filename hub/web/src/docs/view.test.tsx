import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMPTY_FILTERS } from './filters.ts'
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
    subject: 'atlas',
    audiences: ['internal'],
    status: 'current',
    replacementSlug: null,
    delivery: 'demand',
    projectName: 'atlas',
  },
  {
    id: '2',
    slug: 'first-run',
    title: 'Your first run',
    parentId: '1',
    position: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'atlas',
    audiences: ['internal'],
    status: 'current',
    replacementSlug: null,
    delivery: 'demand',
    projectName: 'atlas',
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
    audiences: ['internal'],
    status: 'current',
    replacementSlug: null,
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
    subject: 'atlas',
    audiences: ['technical'],
    status: 'current',
    replacementSlug: null,
    delivery: 'inject',
    projectName: 'atlas',
  },
]

function render(partial: Partial<Parameters<typeof DocsView>[0]> = {}) {
  return renderToStaticMarkup(
    <DocsView
      sourceLabel="Local store"
      items={items}
      selectedId="2"
      filters={EMPTY_FILTERS}
      onFilters={() => {}}
      project="all"
      onProject={() => {}}
      signedIn
      showProjectChooser
      showDrafts={false}
      onShowDrafts={() => {}}
      canShowDrafts
      doc={{
        ...items[1]!,
        body: '## Open a task\n\nEvery piece of work carries a key.\n',
      }}
      replacement={null}
      locationFor={(item) => ({
        to: '/docs/$scope/$subject/$slug',
        params: { scope: item.scope, subject: item.subject ?? '_', slug: item.slug },
        search: {},
      })}
      onSelect={() => {}}
      onOpenFirst={() => {}}
      ready
      searchQuery=""
      onSearchQuery={() => {}}
      searchResults={[]}
      framed={false}
      {...partial}
    />,
  )
}

test('the docs page shows one tree with audience in the filter control', () => {
  const html = render()
  expect(html).toContain('All audiences')
  expect(html).toContain('Audience')
  expect(html).toContain('Technical')
  expect(html).toContain('Getting started')
  expect(html).toContain('Your first run')
  expect(html).toContain('Open a task')
  expect(html).toContain('Docs')
  expect(html).toContain('Local store')
  expect(html).toContain('Install →')
  expect(html).toContain('On this page')
  expect(html).toContain('project / atlas / first-run')
  expect(html).toContain('Search docs')
  expect(html).toContain('Filter')
})

test('About shows every audience on a document', () => {
  const html = render({
    doc: { ...items[1]!, audiences: ['technical', 'internal'], body: 'Body.' },
  })
  expect(html).toContain('Technical, Internal')
})

test('signed out keeps User guide wording and hides the audience filter, project chooser and address', () => {
  const html = render({
    signedIn: false,
    showProjectChooser: false,
    framed: true,
  })
  expect(html).toContain('User guide')
  expect(html).not.toContain('Technical')
  expect(html).not.toContain('All projects')
  expect(html).not.toContain('project / atlas / first-run')
})

test('the audience filter remains available when other filters have one value', () => {
  const html = render({
    items: items.filter((item) => item.scope === 'project' && item.delivery === 'demand'),
  })
  expect(html).toContain('>Filter<')
  expect(html).toContain('All audiences')
})

test('All projects groups roots by subject, and a single project does not', () => {
  const extra: DocsTreeItem = {
    id: 'shared',
    slug: 'shared-note',
    title: 'Shared note',
    parentId: null,
    position: 2,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'global',
    subject: null,
    audiences: ['internal'],
    status: 'current',
    replacementSlug: null,
  }
  const grouped = render({ items: [...items, extra], project: 'all', selectedId: '1' })
  expect(grouped).toContain('Shared')
  const one = render({ items: [...items, extra], project: 'atlas', selectedId: '1' })
  expect(one).not.toContain('Shared')
})

test('the breadcrumb is Docs, the subject and ancestors, not the document title', () => {
  const html = render({ project: 'atlas', selectedId: '2' })
  expect(html).toContain('Docs')
  expect(html).toContain('atlas')
  expect(html).toContain('Getting started')
  expect(html).not.toMatch(/Docs<\/span>.*Your first run<\/span>/)
})

test('a leading title heading in the body is not rendered again', () => {
  const html = render({
    project: 'atlas',
    selectedId: '2',
    doc: {
      ...items[1]!,
      body: '# Your first run\n\nEvery piece of work carries a key.\n',
    },
  })
  expect(html).toContain('Every piece of work carries a key.')
  expect(html).not.toContain('<h1>Your first run</h1>')
})

test('a directly opened document is shown independently of navigation filters', () => {
  const html = render({
    selectedId: '3',
    doc: { ...items[3]!, body: '## Hidden heading\n' },
  })
  expect(html).toContain('Principles')
  expect(html).toContain('Hidden heading')
  expect(html).toContain('On this page')
})

test('a document omitted from navigation stays pending until its body loads', () => {
  const retired: DocsTreeItem = {
    ...items[1]!,
    id: 'retired',
    slug: 'old-run',
    title: 'Old run',
    status: 'archived',
  }
  const pending = render({
    items: [...items, retired],
    selectedId: retired.id,
    doc: null,
  })
  expect(pending).not.toContain('No document to show.')

  const loaded = render({
    items: [...items, retired],
    selectedId: retired.id,
    doc: { ...retired, body: '## Retired instructions\n' },
  })
  expect(loaded).toContain('Old run')
  expect(loaded).toContain('Retired instructions')
  expect(loaded).toContain('Archived')
})

test('New doc sits in the top bar when the local create control is passed', () => {
  const html = render({
    project: 'atlas',
    createAction: <button type="button">New doc</button>,
  })
  expect(html).toContain('New doc')
  expect(render({ project: 'atlas' })).not.toContain('New doc')
})
