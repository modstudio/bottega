import type { Meta, StoryObj } from '@storybook/react-vite'
import { MermaidBlock } from './markdown-mermaid'

const meta = {
  title: 'Views/MarkdownMermaid',
  component: MermaidBlock,
  args: { source: 'flowchart LR\n  A --> B' },
} satisfies Meta<typeof MermaidBlock>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
