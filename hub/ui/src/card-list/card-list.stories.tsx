import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { CardList } from './card-list'

const meta = {
  title: 'Patterns/CardList',
  component: CardList,
  args: {
    label: 'Tasks',
    onOpen: fn(),
    items: [
      {
        key: 'DEV-1214',
        title: ['DEV-1214', 'Give every stored row a UUID identity'],
        aside: 'Active',
        line: ['workshop', 'now', '9h 29m'],
        more: [
          { label: 'Claude', value: '12.4M' },
          { label: 'Vendor', value: '3.1M $4.20' },
        ],
        children: [{ key: 'run', line: ['codex', 'implement', 'Running', '3m 45s'] }],
      },
      {
        key: 'DEV-1397',
        title: ['DEV-1397', 'Hub-web holds only routes'],
        aside: 'Active',
        line: ['workshop', '-', '1h 53m'],
        selected: true,
      },
    ],
  },
} satisfies Meta<typeof CardList>
export default meta
type Story = StoryObj<typeof meta>

export const Opens: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /UUID identity/ }))
    await expect(args.onOpen).toHaveBeenCalledWith('DEV-1214')
  },
}

/** A card's extra fields stay folded until asked for. */
export const ShowsMore: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'More' }))
    await expect(canvas.getByText('3.1M $4.20')).toBeVisible()
  },
}

export const Dark: Story = { globals: { theme: 'dark' } }
