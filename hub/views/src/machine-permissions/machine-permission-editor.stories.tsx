import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { MachinePermissionEditor } from './machine-permission-editor'

const meta = {
  title: 'Views/MachinePermissions/Editor',
  component: MachinePermissionEditor,
  args: {
    machine: {
      additions: { allow: ['Read(*)'], ask: [], deny: [] },
      drop: { allow: [], ask: [], deny: [] },
    },
    change: { run: fn(async () => true), pending: false, error: null },
  },
} satisfies Meta<typeof MachinePermissionEditor>
export default meta
type Story = StoryObj<typeof meta>

export const Rules: Story = {}
