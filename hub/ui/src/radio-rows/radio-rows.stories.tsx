import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { RadioIndicator, RadioRows } from './radio-rows'

const meta: Meta = { title: 'Primitives/RadioRows', component: RadioRows } satisfies Meta<
  typeof RadioRows
>
export default meta
const options = [
  { value: 'fast', label: 'Fast', recommended: true },
  { value: 'thorough', label: 'Thorough' },
]
export const Default: StoryObj<typeof meta> = {
  args: { label: 'Review mode', value: 'fast', options, onChange: () => {} },
}
export const Indicators: StoryObj<typeof meta> = {
  render: () => (
    <>
      <RadioIndicator selected />
      <RadioIndicator selected={false} />
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  render: () => (
    <>
      <RadioRows
        label="Review mode"
        value="fast"
        options={options}
        onChange={(value) => {
          const output = document.querySelector('output[data-radio]')
          if (output) output.textContent = value
        }}
      />
      <output data-radio="">fast</output>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const radios = canvas.getAllByRole('radio')
    radios[0]?.focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(canvas.getByText('thorough')).toBeVisible()
  },
}
