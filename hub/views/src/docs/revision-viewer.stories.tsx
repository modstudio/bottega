import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { RevisionViewer } from './revision-viewer'

const onCurrent = fn()
const meta = {
  title: 'Views/Docs/RevisionViewer',
  component: RevisionViewer,
  args: {
    revision: { body: 'Old text', author: 'sam', at: '2026-10-17T12:00:00Z' },
    replacementBody: 'New text',
    onCurrent,
    mode: 'diff',
    onMode: fn(),
  },
} satisfies Meta<typeof RevisionViewer>
export default meta
type Story = StoryObj<typeof meta>
export const Returns: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Back to current' }))
    await expect(onCurrent).toHaveBeenCalled()
  },
}
