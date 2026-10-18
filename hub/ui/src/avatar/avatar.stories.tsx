import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from './avatar'

const meta = {
  title: 'Primitives/Avatar',
  component: Avatar,
  args: { name: 'Shmuel Barkin', labeled: true },
} satisfies Meta<typeof Avatar>
export default meta
type Story = StoryObj<typeof meta>

export const Person: Story = {}
export const Unknown: Story = { args: { name: null } }
