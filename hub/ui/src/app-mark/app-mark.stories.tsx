import type { Meta, StoryObj } from '@storybook/react-vite'
import { AppMark } from './app-mark'

const meta = {
  title: 'Primitives/AppMark',
  component: AppMark,
  args: { className: 'size-8' },
} satisfies Meta<typeof AppMark>
export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
