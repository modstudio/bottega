import type { Meta, StoryObj } from '@storybook/react-vite'
import { CalendarDays } from 'lucide-react'
import { KeyLine } from './key-line'

const meta = {
  title: 'Views/KeyLine',
  component: KeyLine,
  args: { items: [{ key: 'updated', icon: <CalendarDays size={14} />, content: 'Updated today' }] },
} satisfies Meta<typeof KeyLine>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
