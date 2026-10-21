import type { Meta, StoryObj } from '@storybook/react-vite'
import { useArgs } from 'storybook/preview-api'
import { expect, userEvent, within } from 'storybook/test'
import { Select, type SelectOption } from './select'

const options: SelectOption[] = [
  { value: 'codex', label: 'Codex', note: 'Default' },
  { value: 'claude', label: 'Claude' },
  { value: 'offline', label: 'Offline', disabled: true },
]
const meta: Meta = {
  title: 'Overlays/Select',
  component: Select,
  args: { label: 'Worker', value: 'codex', options },
}
export default meta
function Controlled(args: StoryObj<typeof meta>['args']) {
  const [, updateArgs] = useArgs()
  return (
    <Select
      {...(args as Parameters<typeof Select>[0])}
      onChange={(value) => updateArgs({ value })}
    />
  )
}
export const Sizes: StoryObj<typeof meta> = {
  render: () => (
    <>
      {(['sm', 'md'] as const).map((size) => (
        <Select
          key={size}
          size={size}
          label={`${size} worker`}
          value="codex"
          options={options}
          onChange={() => {}}
        />
      ))}
    </>
  ),
}
export const Keyboard: StoryObj<typeof meta> = {
  render: Controlled,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const select = canvas.getByRole('combobox', { name: 'Worker' })
    select.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    await expect(select).toHaveAttribute('aria-expanded', 'true')
    await expect(select).toHaveAttribute('aria-activedescendant')
  },
}
