import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { FilterPanel } from './filter-panel'

const onChange = fn()
const meta = {
  title: 'Views/Docs/FilterPanel',
  component: FilterPanel,
  args: {
    offered: [
      {
        key: 'audience',
        allLabel: 'All audiences',
        options: [{ value: 'technical', label: 'Technical', count: 3 }],
      },
    ],
    chosen: { audience: null, scope: null, delivery: null },
    onChange,
    total: 4,
    drafts: null,
    working: null,
  },
} satisfies Meta<typeof FilterPanel>
export default meta
type Story = StoryObj<typeof meta>
export const Selects: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Technical'))
    await expect(onChange).toHaveBeenCalled()
  },
}
