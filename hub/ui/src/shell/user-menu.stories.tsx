import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { UserMenu } from './user-menu'

const meta: Meta = {
  title: 'Layout/UserMenu',
  component: UserMenu,
  args: {
    name: 'Ada Lovelace',
    detail: 'Workshop',
    spaces: [
      { id: 'one', name: 'Atelier' },
      { id: 'two', name: 'Atelier' },
    ],
    activeSpaceId: 'one',
    onSelectSpace: () => {},
    themeKey: 'storybook:theme',
    onSignOut: () => {},
  },
}
export default meta
export const SignedIn: StoryObj<typeof meta> = {}
export const Local: StoryObj<typeof meta> = {
  args: {
    name: 'Local',
    detail: 'This machine',
    spaces: [],
    onSelectSpace: undefined,
    onSignOut: undefined,
  },
}
export const Keyboard: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole('button', { name: /Ada Lovelace.*Workshop/ })
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(canvas.getByRole('menuitem', { name: 'Atelier' })).toBeVisible()
  },
}
