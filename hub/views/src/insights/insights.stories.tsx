import type { Meta, StoryObj } from '@storybook/react-vite'
import { RatioView } from './insights'

const meta = {
  title: 'Views/Insights/Ratio',
  component: RatioView,
  args: {
    data: {
      days: [{ day: '2026-10-18', ratio: 250000, excluded: null }],
      perTask: 250000,
      tokens: 500000,
      tasks: 2,
      usableDays: 1,
      direction: 'Lower',
      changePct: -4,
    },
  },
} satisfies Meta<typeof RatioView>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
