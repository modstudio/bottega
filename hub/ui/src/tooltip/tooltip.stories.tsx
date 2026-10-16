import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Tooltip } from './tooltip'

const meta: Meta = { title: 'Overlays/Tooltip', component: Tooltip }
export default meta
export const Sides: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['top', 'bottom'] as const).map((side) => (
        <Tooltip key={side} side={side} label={`${side} help`}>
          <button type="button">{side}</button>
        </Tooltip>
      ))}
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  args: { label: 'Starts a new run', children: <button type="button">Start run</button> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.tab()
    await new Promise((resolve) => setTimeout(resolve, 550))
    await expect(canvas.getByRole('tooltip')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect(canvas.getByRole('tooltip', { hidden: true })).not.toBeVisible()
  },
}
