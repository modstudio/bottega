import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { SnapshotHeader } from './snapshot'

const meta = {
  title: 'Views/Snapshot',
  component: SnapshotHeader,
  args: {
    title: 'Agents',
    takenAt: '2026-10-19T14:30:00Z',
    machineId: 'studio',
    machines: [
      { id: 'studio', takenAt: '2026-10-19T14:30:00Z' },
      { id: 'laptop', takenAt: '2026-10-19T14:20:00Z' },
    ],
    onMachineChange: fn(),
  },
} satisfies Meta<typeof SnapshotHeader>
export default meta
type Story = StoryObj<typeof meta>

export const Available: Story = {}
