import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Input } from './input'

const meta: Meta = { title: 'Primitives/Input', component: Input }
export default meta
export const Sizes: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['sm', 'md', 'title'] as const).map((size) => (
        <Input key={size} size={size} aria-label={`${size} input`} placeholder={size} />
      ))}
    </>
  ),
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox', { name: 'md input' })
    input.focus()
    await userEvent.keyboard('gate')
    await expect(input).toHaveValue('gate')
  },
}
export const States: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Input aria-label="Disabled input" disabled value="Disabled" readOnly />
      <Input aria-label="Invalid input" aria-invalid value="Invalid" readOnly />
    </>
  ),
}
