import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { TreeList } from './tree-view'

const onSelect = fn()
const nodes = [
  {
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
    children: [],
    navigationDisabled: false,
  },
]
const meta = {
  title: 'Views/Docs/TreeView',
  component: TreeList,
  args: { nodes, selectedId: null, collapsed: new Set(), onToggle: fn(), onSelect },
} satisfies Meta<typeof TreeList>
export default meta
type Story = StoryObj<typeof meta>
export const Selects: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'First run' }))
    await expect(onSelect).toHaveBeenCalled()
  },
}
