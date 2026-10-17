import type { Meta, StoryObj } from '@storybook/react-vite'
import { Markdown } from './markdown'

const meta = {
  title: 'Views/Markdown',
  component: Markdown,
  args: { content: '## Heading\n\nA paragraph with **emphasis**.' },
} satisfies Meta<typeof Markdown>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
