import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { EditableStatus } from './doc-field-controls'

const run = fn()
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
  status: 'draft' as const,
  kind: 'article' as const,
  summarySource: 'derived' as const,
  replacementSlug: null,
  delivery: 'demand' as const,
  body: 'Draft.',
}
const field = {
  canAddress: true,
  run,
  pending: false,
  error: null,
  disabled: () => false,
  errorFor: () => undefined,
}
const meta = {
  title: 'Views/Docs/FieldControls',
  component: EditableStatus,
  args: { doc, field },
} satisfies Meta<typeof EditableStatus>
export default meta
type Story = StoryObj<typeof meta>
export const ChangesStatus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole('button', { name: 'Draft' }))
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Current' }))
    await expect(run).toHaveBeenCalledWith({ field: 'status', value: 'current' })
  },
}
