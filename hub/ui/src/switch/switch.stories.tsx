import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Switch } from './switch'

const meta: Meta = { title: 'Primitives/Switch', component: Switch }
export default meta
export const States: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Switch aria-label="Off" />
      <Switch aria-label="On" defaultChecked />
      <Switch aria-label="Disabled" disabled />
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  args: { 'aria-label': 'Email reports' },
  play: async ({ canvasElement }) => {
    const control = within(canvasElement).getByRole('switch', { name: 'Email reports' })
    control.focus()
    await userEvent.keyboard(' ')
    await expect(control).toBeChecked()
  },
}
