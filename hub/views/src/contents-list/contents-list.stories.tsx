import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { ContentsList } from './contents-list'

const meta = {
  title: 'Views/ContentsList',
  component: ContentsList,
  args: {
    items: [
      { id: 'intro', label: 'Introduction', href: '#intro' },
      {
        id: 'details',
        label: 'Details',
        onSelect: fn(),
        children: [{ id: 'nested', label: 'Nested detail', href: '#nested', count: 2 }],
      },
    ],
  },
} satisfies Meta<typeof ContentsList>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {
  play: async ({ canvasElement }) => {
    const item = within(canvasElement).getByRole('button', { name: 'Details' })
    await userEvent.click(item)
    await expect(meta.args.items[1]!.onSelect).toHaveBeenCalledOnce()
  },
}
export const Dark: Story = { globals: { theme: 'dark' } }
