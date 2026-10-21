import type { Meta, StoryObj } from '@storybook/react-vite'
import { useArgs } from 'storybook/preview-api'
import { expect, userEvent, within } from 'storybook/test'
import { Tabs } from './tabs'

const meta: Meta = {
  title: 'Patterns/Tabs',
  component: Tabs,
  args: {
    label: 'Run details',
    value: 'summary',
    items: [
      { value: 'summary', label: 'Summary', count: 3 },
      { value: 'logs', label: 'Logs' },
    ],
  },
}
export default meta
function Controlled(args: StoryObj<typeof meta>['args']) {
  const [, updateArgs] = useArgs()
  return (
    <Tabs {...(args as Parameters<typeof Tabs>[0])} onChange={(value) => updateArgs({ value })} />
  )
}
export const Keyboard: StoryObj<typeof meta> = {
  render: Controlled,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const summary = canvas.getByRole('tab', { name: /Summary/ })
    const panel = document.createElement('div')
    panel.id = summary.getAttribute('aria-controls') ?? ''
    panel.setAttribute('role', 'tabpanel')
    canvasElement.append(panel)
    summary.focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect(canvas.getByRole('tab', { name: 'Logs' })).toHaveFocus()
  },
}
