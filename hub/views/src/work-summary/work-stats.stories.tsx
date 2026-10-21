import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkStats } from './work-stats'

const meta = {
  title: 'Views/Work summary/Stats',
  component: WorkStats,
  args: {
    response: { engaged: '6h 12m', activeAgents: ['codex', 'claude'], tasksShipped: 14 },
  },
} satisfies Meta<typeof WorkStats>
export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {}
