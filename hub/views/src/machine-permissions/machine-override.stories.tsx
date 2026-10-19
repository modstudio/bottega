import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { MachineOverride } from './machine-override'

const meta = {
  title: 'Views/MachinePermissions/Override',
  component: MachineOverride,
  args: {
    label: 'Agent',
    value: 'codex',
    options: [
      { value: 'codex', label: 'Codex' },
      { value: 'claude', label: 'Claude' },
    ],
    pending: false,
    onSet: fn(),
    onRemove: fn(),
  },
} satisfies Meta<typeof MachineOverride>
export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {}
export const Inherited: Story = { args: { value: undefined } }
