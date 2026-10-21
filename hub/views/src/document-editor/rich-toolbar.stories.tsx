import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEditor } from '@tiptap/react'
import { expect, userEvent, within } from 'storybook/test'
import { richExtensions } from './rich-extensions'
import { RichToolbar } from './rich-toolbar'

const meta = { title: 'Views/RichToolbar', component: RichToolbar } satisfies Meta
export default meta
type Story = StoryObj
export const Light: Story = {
  render: function RenderToolbar() {
    const editor = useEditor({ extensions: richExtensions(), content: '<p>Text</p>' })
    return <>{editor ? <RichToolbar editor={editor} /> : <span>Loading editor</span>}</>
  },
  play: async ({ canvasElement }) => {
    const bold = within(canvasElement).getByRole('button', { name: 'Bold' })
    const before = bold.className
    await userEvent.click(bold)
    await expect(bold.className).not.toBe(before)
  },
}
export const Dark: Story = {
  globals: { theme: 'dark' },
  render: function RenderToolbar() {
    const editor = useEditor({ extensions: richExtensions(), content: '<p>Text</p>' })
    return <>{editor ? <RichToolbar editor={editor} /> : <span>Loading editor</span>}</>
  },
}
