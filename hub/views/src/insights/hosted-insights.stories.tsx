import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { HostedHealth } from './hosted-insights'

const meta = {
  title: 'Views/Insights/Hosted health',
  component: HostedHealth,
  args: {
    snapshot: null,
    pending: false,
    error: null,
    machineId: undefined,
    onMachineChange: fn(),
  },
} satisfies Meta<typeof HostedHealth>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {}
