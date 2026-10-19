import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { SearchDialog } from './search'

const choose = fn()
const item = {
  id: 'guide',
  slug: 'guide',
  title: 'First run',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-18T12:00:00Z',
  scope: 'global' as const,
  subject: null,
  audiences: ['internal'] as ['internal'],
  status: 'current' as const,
  kind: 'article' as const,
  summarySource: 'derived' as const,
  replacementSlug: null,
  delivery: 'demand' as const,
}
const meta = {
  title: 'Views/Docs/Search',
  component: SearchDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    query: 'first',
    onQueryChange: fn(),
    results: [
      {
        ...item,
        summary: 'Dispatch a first run.',
        snippet: 'Dispatch your first run.',
        highlights: [],
      },
    ],
    tree: [item],
    onChoose: choose,
    scopeLabel: 'All docs',
  },
} satisfies Meta<typeof SearchDialog>
export default meta
type Story = StoryObj<typeof meta>
export const Chooses: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const input = canvas.getByRole('searchbox')
    await userEvent.type(input, '{Enter}')
    await expect(choose).toHaveBeenCalled()
  },
}
