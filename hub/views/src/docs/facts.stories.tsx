import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { DocsFacts } from './facts'

const onRevision = fn()
const doc = {
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
  summary: 'Dispatch a first run.',
  summarySource: 'written' as const,
  replacementSlug: null,
  delivery: 'demand' as const,
  body: '## Start\n\nDispatch a run.',
}
const meta = {
  title: 'Views/Docs/Facts',
  component: DocsFacts,
  args: {
    doc,
    headings: [],
    signedIn: true,
    showHistory: true,
    history: {
      items: [{ id: 3, at: '2026-10-18T12:00:00Z', reason: 'Clarify setup', author: 'sam' }],
      pending: false,
      error: null,
    },
    onRevision,
  },
} satisfies Meta<typeof DocsFacts>
export default meta
type Story = StoryObj<typeof meta>
export const OpensRevision: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const history = canvas.getByRole('button', { name: /History/ })
    if (history.getAttribute('aria-expanded') === 'false') await userEvent.click(history)
    await userEvent.click(canvas.getByTitle(/Clarify setup/))
    await expect(onRevision).toHaveBeenCalledWith(3)
  },
}
