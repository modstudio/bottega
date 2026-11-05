import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { AutonomyLayers } from './autonomy-layers'

const stageOptions = ['ask', 'review', 'auto'].map((value) => ({ value, label: value }))
const none = { plan: null, canon: null }

const meta = {
  title: 'Views/Machine permissions/Autonomy layers',
  component: AutonomyLayers,
  parameters: { layout: 'padded' },
  args: {
    columns: [
      { id: 'plan', label: 'Plan' },
      { id: 'canon', label: 'Canon' },
    ],
    layers: [
      { scope: 'project', label: 'Project settings', hint: 'From the register.', values: none },
      {
        scope: 'local user',
        label: 'This machine',
        hint: 'Every project on this machine.',
        values: { plan: null, canon: 'ask' },
        editable: {
          plan: { options: stageOptions, selected: null, unset: { label: 'Not set' } },
          canon: { options: stageOptions, selected: 'ask', unset: { label: 'Not set' } },
        },
      },
      {
        scope: 'hosted user',
        label: 'Your account',
        hint: 'Every machine you sign in on.',
        values: { plan: 'auto', canon: 'auto' },
        editable: {
          plan: { options: stageOptions, selected: null, unset: { label: 'Preset (auto)' } },
        },
      },
      {
        scope: 'built-in',
        label: 'Built-in',
        hint: 'When no layer says anything.',
        values: { plan: 'per step', canon: 'per step' },
      },
    ],
    edit: { run: fn(), pending: false, error: null },
  },
} satisfies Meta<typeof AutonomyLayers>

export default meta
type Story = StoryObj<typeof meta>

export const Waterfall: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const inEffect = (setting: string) =>
      within(canvas.getByText(setting).closest('tr')!).getAllByRole('cell')[1]
    await expect(inEffect('Plan')).toHaveTextContent('autoYour account')
    await expect(inEffect('Canon')).toHaveTextContent('askThis machine')
    await userEvent.click(canvas.getByRole('combobox', { name: 'This machine: Canon' }))
    await userEvent.click(await canvas.findByRole('option', { name: 'Not set' }))
    await expect(args.edit.run).toHaveBeenCalledWith('local user', 'canon', null)
  },
}
