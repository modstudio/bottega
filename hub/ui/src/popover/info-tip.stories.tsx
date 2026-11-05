import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { InfoTip } from './info-tip'

const meta: Meta<typeof InfoTip> = { title: 'Overlays/InfoTip', component: InfoTip }
export default meta

export const OpensOnClick: StoryObj<typeof meta> = {
  args: {
    label: 'About permissions',
    children: 'What agents may do without asking. Applied to every agent when a session starts.',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'About permissions' }))
    await expect(canvas.getByRole('dialog', { name: 'About permissions' })).toBeVisible()
  },
}
