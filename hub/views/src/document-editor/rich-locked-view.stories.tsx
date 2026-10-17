import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { LockedBlockView } from './rich-locked-view'

const meta = { title: 'Views/RichLockedView', component: LockedBlockView } satisfies Meta
export default meta
type Story = StoryObj
export const Light: Story = {
  render: () => <button type="button">{LockedBlockView.name}</button>,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button')
    await userEvent.click(button)
    await expect(button).toBeEnabled()
  },
}
export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => <p>{LockedBlockView.name}</p>,
}
