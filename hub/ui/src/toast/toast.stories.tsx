import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Toaster, toast } from './toast'

const meta: Meta = { title: 'Overlays/Toast', component: Toaster }
export default meta
export const Kinds: StoryObj<typeof meta> = {
  render: () => (
    <>
      <button type="button" onClick={() => toast.success('Run completed')}>
        Success
      </button>
      <button type="button" onClick={() => toast.error('Gate failed')}>
        Error
      </button>
      <button type="button" onClick={() => toast.info('Run queued')}>
        Info
      </button>
      <Toaster />
    </>
  ),
}
export const Warning: StoryObj<typeof meta> = {
  render: () => (
    <>
      <button
        type="button"
        onClick={() =>
          toast.warning(
            'Task DEV-1 is closed, but claim cleanup remains.\nclear it with: bottega board claim release-task DEV-1 --project workshop-with-a-long-name',
          )
        }
      >
        Show warning
      </button>
      <Toaster />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Show warning' }))
    const notification = canvas.getByRole('listitem')
    await waitFor(() =>
      expect(within(notification).getByText(/Task DEV-1 is closed/)).toBeVisible(),
    )
    await userEvent.click(within(notification).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(canvas.queryByRole('listitem')).not.toBeInTheDocument())
  },
}
export const Keyboard: StoryObj<typeof meta> = {
  render: () => (
    <>
      <button type="button" onClick={() => toast.info('Run queued')}>
        Notify
      </button>
      <Toaster />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole('button', { name: 'Notify' })
    button.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(canvas.getByText('Run queued')).toBeVisible())
    const dismiss = canvas.getByRole('button', { name: 'Dismiss' })
    dismiss.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.queryByText('Run queued')).not.toBeInTheDocument()
  },
}
