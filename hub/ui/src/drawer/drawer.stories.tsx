import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { Drawer } from './drawer'

const meta = {
  title: 'Overlays/Drawer',
  component: Drawer,
  args: {
    open: true,
    onClose: fn(),
    title: 'Documents',
    children: (
      <ul>
        <li>Plan</li>
        <li>Survey</li>
      </ul>
    ),
  },
} satisfies Meta<typeof Drawer>
export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole('button', { name: 'Close' }))
    await expect(args.onClose).toHaveBeenCalled()
  },
}

export const Dark: Story = { globals: { theme: 'dark' } }
