import type { Meta, StoryObj } from '@storybook/react-vite'
import { ReviewLensList } from './reviews'

const meta = {
  title: 'Views/Reviews',
  component: ReviewLensList,
  args: { lenses: [] },
} satisfies Meta<typeof ReviewLensList>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {}
