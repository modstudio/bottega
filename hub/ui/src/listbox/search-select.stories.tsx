import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { SearchSelect } from './search-select'

const meta: Meta = { title: 'Overlays/SearchSelect', component: SearchSelect } satisfies Meta<
  typeof SearchSelect
>
export default meta
const options = [
  { value: 'workshop', label: 'Workshop' },
  { value: 'atelier', label: 'Atelier' },
  { value: 'workshop', label: 'Workshop' },
]
export const Keyboard: StoryObj<typeof meta> = {
  args: {
    label: 'Project',
    value: 'workshop',
    options,
    onChange: () => {},
    trigger: <button type="button">Choose project</button>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole('button', { name: 'Choose project' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    const search = canvas.getByRole('textbox', { name: 'Search project' })
    await expect(search).toHaveFocus()
    await userEvent.type(search, 'work')
    await userEvent.keyboard('{Enter}')
    await expect(canvas.queryByRole('dialog', { name: 'Project' })).not.toBeInTheDocument()
  },
}
export const NoMatch: StoryObj<typeof meta> = {
  args: {
    label: 'Project',
    value: '',
    options: [],
    onChange: () => {},
    trigger: <button type="button">Empty project list</button>,
  },
}
