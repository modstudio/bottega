import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Menu } from './menu'

const meta: Meta = { title: 'Overlays/Menu', component: Menu }
export default meta
const items = [
  { label: 'Open', onSelect: () => {} },
  { label: 'Unavailable', disabled: true, onSelect: () => {} },
  { label: 'Delete', danger: true, onSelect: () => {} },
]
export const Placements: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['start', 'end'] as const).map((align) => (
        <Menu
          key={align}
          align={align}
          trigger={<button type="button">{align}</button>}
          items={items}
          header="Task actions"
        />
      ))}
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  args: { trigger: <button type="button">Task menu</button>, items },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole('button', { name: 'Task menu' })
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(canvas.getByRole('menuitem', { name: 'Open' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(canvas.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  },
}
