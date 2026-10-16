import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Companion, Docked } from './companion'

const meta: Meta = {
  title: 'Layout/Companion',
  component: Companion,
  args: {
    title: 'DEV-1378',
    subtitle: 'Storybook catalog',
    onClose: () => {},
    actions: <button type="button">Edit</button>,
    footer: <button type="button">Done</button>,
    children: <p>Implementation details.</p>,
  },
}
export default meta
export const Open: StoryObj<typeof meta> = {}
export const DockedLayout: StoryObj<typeof meta> = {
  render: (args) => (
    <Docked panel={<Companion {...(args as Parameters<typeof Companion>[0])} />}>
      <main>Task list</main>
    </Docked>
  ),
}
function Controlled(args: StoryObj<typeof meta>['args']) {
  const close = () => {
    document.querySelector<HTMLElement>('[data-companion-story]')?.setAttribute('hidden', '')
    document.querySelector<HTMLElement>('[data-companion-closed]')?.removeAttribute('hidden')
  }
  return (
    <>
      <div data-companion-story="">
        <Companion {...(args as Parameters<typeof Companion>[0])} onClose={close} />
      </div>
      <p data-companion-closed="" hidden>
        Panel closed
      </p>
    </>
  )
}
export const Keyboard: StoryObj<typeof meta> = {
  render: Controlled,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const panel = canvas.getByRole('complementary')
    await expect(panel).toHaveFocus()
    const resize = canvas.getByRole('button', { name: 'Resize panel, 420 pixels wide' })
    resize.focus()
    await userEvent.keyboard('{ArrowLeft}')
    await expect(
      canvas.getByRole('button', { name: 'Resize panel, 480 pixels wide' }),
    ).toHaveFocus()
    const resizedPanel = canvas.getByRole('complementary')
    resizedPanel.focus()
    await expect(resizedPanel).toHaveFocus()
    resizedPanel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await userEvent.tab()
    await expect(canvas.queryByRole('complementary')).not.toBeInTheDocument()
    await expect(canvas.getByText('Panel closed')).toBeVisible()
  },
}
