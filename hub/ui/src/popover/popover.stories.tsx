import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Popover } from './popover'

const meta: Meta = { title: 'Overlays/Popover', component: Popover }
export default meta
export const Placements: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['top', 'right', 'bottom'] as const).map((side) => (
        <Popover
          key={side}
          label={`${side} panel`}
          side={side}
          trigger={<button type="button">{side}</button>}
        >
          Panel content
        </Popover>
      ))}
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  args: {
    label: 'Filters',
    trigger: <button type="button">Open filters</button>,
    children: <p>Status and project filters</p>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole('button', { name: 'Open filters' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(canvas.getByRole('dialog', { name: 'Filters' })).toBeVisible())
  },
}
