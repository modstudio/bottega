import type { Meta, StoryObj } from '@storybook/react-vite'
import { WaitingBadge } from './waiting-badge'

const meta = {
  title: 'Views/Waiting badge',
  component: WaitingBadge,
  args: {
    renderLink: (children) => <a href="#waiting">{children}</a>,
  },
} satisfies Meta<typeof WaitingBadge>
export default meta
type Story = StoryObj<typeof meta>

export const Question: Story = {}
