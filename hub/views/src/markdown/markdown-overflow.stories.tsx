import type { Meta, StoryObj } from '@storybook/react-vite'
import { DocOverflow } from './markdown-overflow'

const meta = {
  title: 'Views/MarkdownOverflow',
  component: DocOverflow,
  args: { expandLabel: 'Expand table', title: 'Table', children: <p>Wide content</p> },
} satisfies Meta<typeof DocOverflow>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
