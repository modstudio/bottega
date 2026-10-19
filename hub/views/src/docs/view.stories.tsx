import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { DocsView } from './view'

const item = {
  id: 'guide',
  slug: 'guide',
  title: 'First run',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-18T12:00:00Z',
  scope: 'global',
  subject: null,
  audiences: ['internal'] as ['internal'],
  status: 'current' as const,
  kind: 'article' as const,
  summarySource: 'derived' as const,
  replacementSlug: null,
  delivery: 'demand' as const,
}
const onSelect = fn()
const meta = {
  title: 'Views/Docs/View',
  component: DocsView,
  parameters: { layout: 'fullscreen' },
  args: {
    sourceLabel: 'Local store',
    items: [item],
    selectedId: item.id,
    filters: { audience: null, scope: null, delivery: null },
    onFilters: fn(),
    project: 'all',
    onProject: fn(),
    signedIn: true,
    showProjectChooser: false,
    showDrafts: false,
    onShowDrafts: fn(),
    canShowDrafts: true,
    canShowWorking: false,
    showWorking: false,
    onShowWorking: fn(),
    doc: { ...item, body: '## Start\n\nDispatch a run.' },
    replacement: null,
    renderLink: (_item, children) => <a href="#guide">{children}</a>,
    onSelect,
    onOpenFirst: fn(),
    ready: true,
    searchQuery: '',
    onSearchQuery: fn(),
    searchResults: [],
    framed: false,
    showHistory: true,
    history: { items: [], pending: false, error: null },
  },
} satisfies Meta<typeof DocsView>
export default meta
type Story = StoryObj<typeof meta>
export const SelectsTreeItem: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'First run' }))
    await expect(onSelect).toHaveBeenCalled()
  },
}
