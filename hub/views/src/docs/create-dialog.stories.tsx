import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { CreateDocDialog } from './create-dialog'

const create = fn(async () => ({}))
const meta = {
  title: 'Views/Docs/CreateDialog',
  component: CreateDocDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    subjects: {},
    create: { run: create, pending: false, error: null },
    onCreated: fn(async () => {}),
  },
} satisfies Meta<typeof CreateDocDialog>
export default meta
type Story = StoryObj<typeof meta>
export const Creates: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.type(canvas.getByLabelText('Slug'), 'first-run')
    await userEvent.type(canvas.getByLabelText('Title'), 'First run')
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }))
    await expect(create).toHaveBeenCalled()
  },
}
