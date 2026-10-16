import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Checkbox } from './checkbox'

const meta: Meta = { title: 'Primitives/Checkbox', component: Checkbox }
export default meta
export const States: StoryObj<typeof meta> = {
  render: () => (
    <>
      <label htmlFor="unchecked">
        <Checkbox id="unchecked" /> Unchecked
      </label>
      <label htmlFor="checked">
        <Checkbox id="checked" defaultChecked /> Checked
      </label>
      <label htmlFor="mixed">
        <Checkbox id="mixed" indeterminate /> Mixed
      </label>
      <label htmlFor="disabled">
        <Checkbox id="disabled" disabled /> Disabled
      </label>
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  args: { 'aria-label': 'Include finished runs' },
  play: async ({ canvasElement }) => {
    const checkbox = within(canvasElement).getByRole('checkbox', { name: 'Include finished runs' })
    checkbox.focus()
    await userEvent.keyboard(' ')
    await expect(checkbox).toBeChecked()
  },
}
