import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ControlSizeProvider } from './control-size'
import { Input } from './input'

const meta: Meta = { title: 'Primitives/ControlSize', component: ControlSizeProvider }
export default meta

const height = (element: HTMLElement) => element.getBoundingClientRect().height

/** A control without its own size takes the band's; a control's own size still wins. */
export const BandSize: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Input size="sm" aria-label="Explicit small" />
      <ControlSizeProvider size="sm">
        <Input aria-label="From band" />
        <Input size="md" aria-label="Own size" />
      </ControlSizeProvider>
      <Input aria-label="Default" />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const band = canvas.getByRole('textbox', { name: 'From band' })
    await userEvent.type(band, 'gate')
    await expect(band).toHaveValue('gate')
    const small = height(canvas.getByRole('textbox', { name: 'Explicit small' }))
    const fallback = height(canvas.getByRole('textbox', { name: 'Default' }))
    await expect(small).toBeLessThan(fallback)
    await expect(height(band)).toBe(small)
    await expect(height(canvas.getByRole('textbox', { name: 'Own size' }))).toBe(fallback)
  },
}
