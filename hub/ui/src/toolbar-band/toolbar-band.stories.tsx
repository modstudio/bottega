import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ToolbarBand } from './toolbar-band'

const meta: Meta = { title: 'Layout/ToolbarBand', component: ToolbarBand } satisfies Meta<
  typeof ToolbarBand
>
export default meta
export const Full: StoryObj<typeof meta> = {
  args: {
    search: <input aria-label="Search tasks" />,
    filters: <button type="button">Status</button>,
    filtersActive: true,
    view: <button type="button">List</button>,
    tabs: <button type="button">Open</button>,
    actions: <button type="button">New</button>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }))
    await expect(canvas.getByRole('textbox', { name: 'Search tasks' })).toHaveFocus()
  },
}
