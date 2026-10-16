import type { Meta, StoryObj } from '@storybook/react-vite'
import { Textarea } from './textarea'

const meta: Meta = { title: 'Primitives/Textarea', component: Textarea }
export default meta
export const Variants: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Textarea aria-label="Default notes" defaultValue="A concise note." />
      <Textarea aria-label="Code" code defaultValue="bun run check" />
      <Textarea aria-label="Bare editor" bare defaultValue="Document body" />
    </>
  ),
}
export const Disabled: StoryObj<typeof meta> = {
  args: { 'aria-label': 'Disabled notes', disabled: true, value: 'Unavailable' },
}
