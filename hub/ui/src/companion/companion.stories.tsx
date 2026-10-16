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
export const Keyboard: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement).getByRole('complementary')
    await expect(panel).toHaveFocus()
    await userEvent.keyboard('{Escape}')
  },
}
