import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Button, IconButton, TextButton } from './button'

const meta: Meta = { title: 'Primitives/Button', component: Button }
export default meta
export const Variants: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
    </>
  ),
}
export const Sizes: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Button key={size} size={size}>
          {size}
        </Button>
      ))}
    </>
  ),
}
export const States: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Button disabled>Disabled</Button>
      <IconButton label="Add task">
        <span aria-hidden>+</span>
      </IconButton>
      <span>
        Read the <TextButton>details</TextButton>.
      </span>
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Button
        onClick={(event) => {
          const status = event.currentTarget.nextElementSibling
          if (status) status.textContent = 'Activated'
        }}
      >
        Run gate
      </Button>
      <output>Idle</output>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole('button', { name: 'Run gate' })
    button.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByText('Activated')).toBeVisible()
  },
}
