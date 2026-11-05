import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { PermissionMatrix } from './permission-matrix'

const run = fn(async () => true)

const meta = {
  title: 'Views/Machine permissions/Permission matrix',
  component: PermissionMatrix,
  parameters: { layout: 'padded' },
  args: {
    columns: [
      { layer: 'account', label: 'Your account' },
      { layer: 'project', label: 'alpha' },
      { layer: 'machine', label: 'This machine' },
    ],
    rows: [
      { rule: 'Bash(git:*)', values: { account: 'allow' } },
      { rule: 'Bash(git push --force:*)', values: { account: 'ask' } },
      { rule: 'Bash(rm -rf /)', values: { account: 'deny' } },
      { rule: 'Read', values: { account: 'allow' } },
      { rule: 'mcp__starship__*', values: { account: 'allow', machine: 'drop' } },
      { rule: 'Bash(bun run:*)', values: { project: 'allow' } },
    ],
    save: { run, pending: false, error: null },
  },
} satisfies Meta<typeof PermissionMatrix>

export default meta
type Story = StoryObj<typeof meta>

export const Grouped: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByText('Read any file')).not.toBeInTheDocument()
    await expect(canvas.getByText('1 allowed · 1 ask first')).toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: /Git/ }))
    await expect(canvas.getByText('Run git push --force …')).toBeInTheDocument()
    await userEvent.type(canvas.getByRole('textbox', { name: 'Search permissions' }), 'starship')
    await expect(canvas.queryByText('Read any file')).not.toBeInTheDocument()
  },
}

export const OneSave: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /Files/ }))
    await userEvent.click(canvas.getByRole('combobox', { name: 'Your account: Read any file' }))
    await userEvent.click(canvas.getByRole('option', { name: 'Blocked' }))
    await expect(canvas.getByText('1 unsaved change')).toBeInTheDocument()
    await userEvent.type(canvas.getByRole('textbox', { name: 'Change reason' }), 'tighten')
    await userEvent.click(canvas.getByRole('button', { name: /Save/ }))
    await expect(run).toHaveBeenCalledWith(
      [{ rule: 'Read', layer: 'account', from: 'allow', to: 'deny' }],
      'tighten',
    )
  },
}

export const Refused: Story = {
  args: { save: { run, pending: false, error: null, refusal: 'Sign in to change permissions.' } },
}
