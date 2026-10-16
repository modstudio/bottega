import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Dialog } from './dialog'

const meta: Meta = {
  title: 'Overlays/Dialog',
  component: Dialog,
  args: {
    open: true,
    onOpenChange: () => {},
    title: 'Discard run?',
    description: 'The branch remains available.',
    children: <p>Uncommitted work will be retained.</p>,
    footer: <button type="button">Discard</button>,
  },
}
export default meta
export const Small: StoryObj<typeof meta> = { args: { size: 'sm' } }
export const Medium: StoryObj<typeof meta> = { args: { size: 'md' } }
export const Large: StoryObj<typeof meta> = { args: { size: 'lg' } }
export const Full: StoryObj<typeof meta> = { args: { size: 'full' } }
export const Chromeless: StoryObj<typeof meta> = {
  args: {
    variant: 'chromeless',
    title: 'Command palette',
    children: <input aria-label="Command" />,
  },
}
function Controlled(args: StoryObj<typeof meta>['args']) {
  return (
    <Dialog
      {...(args as Parameters<typeof Dialog>[0])}
      onOpenChange={(open) => {
        if (!open) document.querySelector<HTMLDialogElement>('dialog[open]')?.close()
      }}
    />
  )
}
export const Keyboard: StoryObj<typeof meta> = {
  render: Controlled,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const dialog = canvas.getByRole('dialog', { name: 'Discard run?' })
    await expect(dialog).toBeVisible()
    const close = canvas.getByRole('button', { name: 'Close' })
    close.focus()
    await userEvent.keyboard('{Enter}')
    await expect(dialog).not.toBeVisible()
  },
}
