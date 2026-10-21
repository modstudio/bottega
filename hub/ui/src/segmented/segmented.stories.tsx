import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Segmented } from './segmented'

const meta: Meta = { title: 'Patterns/Segmented', component: Segmented }
export default meta
const options = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
]
export const Sizes: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['sm', 'md'] as const).map((size) => (
        <Segmented
          key={size}
          size={size}
          label={`${size} filter`}
          value="all"
          options={options}
          onChange={() => {}}
        />
      ))}
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Segmented
        label="Task filter"
        value="all"
        options={options}
        onChange={(value) => {
          const output = document.querySelector('output[data-segment]')
          if (output) output.textContent = value
        }}
      />
      <output data-segment="">all</output>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const open = canvas.getByRole('button', { name: 'Open' })
    open.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByText('open')).toBeVisible()
  },
}
