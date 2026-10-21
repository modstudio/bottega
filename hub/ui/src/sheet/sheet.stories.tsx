import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Sheet } from './sheet'

const meta: Meta = {
  title: 'Overlays/Sheet',
  component: Sheet,
  args: {
    open: true,
    onClose: () => {},
    title: 'Task settings',
    subtitle: 'DEV-1378',
    actions: <button type="button">Archive</button>,
    tabs: <div>Details · History</div>,
    context: 'Workshop',
    footer: <button type="button">Save</button>,
    destructive: <button type="button">Delete task</button>,
    children: (
      <label>
        Title <input defaultValue="Storybook catalog" />
      </label>
    ),
  },
}
export default meta
export const Default: StoryObj<typeof meta> = { args: { size: 'default' } }
export const Wide: StoryObj<typeof meta> = { args: { size: 'wide' } }
export const Document: StoryObj<typeof meta> = { args: { size: 'document' } }
function Controlled(args: StoryObj<typeof meta>['args']) {
  return (
    <Sheet
      {...(args as Parameters<typeof Sheet>[0])}
      onClose={() => document.querySelector<HTMLDialogElement>('dialog[open]')?.close()}
    />
  )
}
export const Keyboard: StoryObj<typeof meta> = {
  render: Controlled,
  play: async ({ canvasElement }) => {
    const dialog = within(canvasElement).getByRole('dialog', { name: 'Task settings' })
    const close = within(dialog).getByRole('button', { name: 'Close' })
    await expect(close).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect(dialog).not.toBeVisible()
  },
}
