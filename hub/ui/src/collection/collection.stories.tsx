import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { Collection } from './collection'

const rows = [
  { id: 'DEV-1397', title: 'Move presentation components', status: 'Active' },
  { id: 'DEV-1398', title: 'Move routed screens', status: 'Open' },
]
const onOpen = fn()

const meta = {
  title: 'Patterns/Collection',
  component: Collection,
  args: {
    title: 'Tasks',
    count: rows.length,
    rows,
    columns: [
      { id: 'id', label: 'Key', phone: 'aside', render: (row) => row.id },
      { id: 'title', label: 'Title', phone: 'title', grow: true, render: (row) => row.title },
      { id: 'status', label: 'Status', phone: 'line', render: (row) => row.status },
    ],
    getKey: (row) => row.id,
    onOpen,
    empty: { title: 'No tasks' },
  },
} satisfies Meta<typeof Collection<(typeof rows)[number]>>
export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText('Move presentation components'))
    await expect(onOpen).toHaveBeenCalled()
  },
}
export const Dark: Story = { globals: { theme: 'dark' } }
