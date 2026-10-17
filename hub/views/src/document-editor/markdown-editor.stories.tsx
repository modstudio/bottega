import type { Meta, StoryObj } from '@storybook/react-vite'
import { MarkdownEditor } from './markdown-editor'

const meta = {
  title: 'Views/MarkdownEditor',
  component: MarkdownEditor,
  args: { value: '## Editable body', onChange: () => {}, onModSave: () => {} },
} satisfies Meta<typeof MarkdownEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
