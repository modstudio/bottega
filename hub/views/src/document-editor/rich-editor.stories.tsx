import type { Meta, StoryObj } from '@storybook/react-vite'
import { RichEditor } from './rich-editor'

const meta = {
  title: 'Views/RichEditor',
  component: RichEditor,
  args: {
    value: '## Editable body',
    onChange: () => {},
    onReady: () => {},
    onSwitchToMarkdown: () => {},
  },
} satisfies Meta<typeof RichEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
