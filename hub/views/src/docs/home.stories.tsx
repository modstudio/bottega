import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { DocsHome } from './home'

const item = {
  id: 'guide',
  slug: 'guide',
  title: 'First run',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-18T12:00:00Z',
  scope: 'global',
  subject: null,
  audiences: ['customer'] as ['customer'],
  status: 'current' as const,
  kind: 'article' as const,
  summary: 'Dispatch a first run.',
  summarySource: 'written' as const,
  replacementSlug: null,
  delivery: 'demand' as const,
  featured: true,
}
const meta = {
  title: 'Views/Docs/Home',
  component: DocsHome,
  parameters: { layout: 'fullscreen' },
  args: {
    sourceLabel: 'Published',
    items: [item],
    results: [],
    query: '',
    onQuery: fn(),
    onSelect: fn(),
    loading: false,
    error: null,
  },
} satisfies Meta<typeof DocsHome>
export default meta
type Story = StoryObj<typeof meta>
export const Searches: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole('button', { name: /Search titles/ }))
    await expect(canvas.getByRole('dialog', { name: 'Search docs' })).toHaveAttribute('open')
  },
}
