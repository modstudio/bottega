import type { Meta, StoryObj } from '@storybook/react-vite'
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
}
export const States: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Input aria-label="Disabled input" disabled value="Disabled" readOnly />
      <Input aria-label="Invalid input" aria-invalid value="Invalid" readOnly />
    </>
  ),
}
