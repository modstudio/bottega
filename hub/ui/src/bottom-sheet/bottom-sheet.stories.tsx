import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { BottomSheet } from './bottom-sheet'

const meta: Meta = {
  title: 'Overlays/BottomSheet',
  component: BottomSheet,
  args: {
    open: true,
    title: 'Filters',
    onClose: () => {},
    children: <button type="button">Running</button>,
  },
}
export default meta
export const Open: StoryObj<typeof meta> = {}
function Controlled(args: StoryObj<typeof meta>['args']) {
  return (
    <BottomSheet
      {...(args as Parameters<typeof BottomSheet>[0])}
      onClose={() => document.querySelector<HTMLDialogElement>('dialog[open]')?.close()}
    />
  )
}
export const Keyboard: StoryObj<typeof meta> = {
  render: Controlled,
  play: async ({ canvasElement }) => {
    const dialog = within(canvasElement).getByRole('dialog', { name: 'Filters' })
    await expect(dialog).toBeVisible()
    const close = within(dialog).getByRole('button', { name: 'Close' })
    close.focus()
    await userEvent.keyboard('{Enter}')
    await expect(dialog).not.toBeVisible()
  },
}
