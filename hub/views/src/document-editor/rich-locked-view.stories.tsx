import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNodeViewProps } from '@tiptap/react'
import { expect, fn, userEvent, within } from 'storybook/test'
import { RichEditContext } from './rich-edit-context'
import { LockedBlockView } from './rich-locked-view'

const nodeViewProps = {
  node: { attrs: { source: '```generated\n```', label: 'Generated list' } },
} as unknown as ReactNodeViewProps
const switchToMarkdown = fn()

const meta = { title: 'Views/RichLockedView', component: LockedBlockView } satisfies Meta
export default meta
type Story = StoryObj
export const Light: Story = {
  render: () => (
    <RichEditContext.Provider value={{ switchToMarkdown }}>
      <LockedBlockView {...nodeViewProps} />
    </RichEditContext.Provider>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Edit in Markdown mode' }),
    )
    await expect(switchToMarkdown).toHaveBeenCalledOnce()
  },
}
export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <RichEditContext.Provider value={{ switchToMarkdown }}>
      <LockedBlockView {...nodeViewProps} />
    </RichEditContext.Provider>
  ),
}
