import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { DocActions } from './doc-actions'

const run = fn(async () => {})
const meta = {
  title: 'Views/Docs/DocActions',
  component: DocActions,
  args: { remove: { run, pending: false, error: null } },
} satisfies Meta<typeof DocActions>
export default meta
type Story = StoryObj<typeof meta>
export const Deletes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole('button', { name: 'Delete article' }))
    await userEvent.type(canvas.getByLabelText('Reason'), 'Superseded')
    await userEvent.click(canvas.getAllByRole('button', { name: 'Delete article' })[1]!)
    await expect(run).toHaveBeenCalledWith('Superseded')
  },
}
