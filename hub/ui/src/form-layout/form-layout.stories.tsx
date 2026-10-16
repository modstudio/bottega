import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { Copyable, DisplayRow, FieldSection, SettingBlock } from './form-layout'

const meta: Meta = { title: 'Patterns/FormLayout', component: FieldSection } satisfies Meta<
  typeof FieldSection
>
export default meta
export const Settings: StoryObj<typeof meta> = {
  render: () => (
    <FieldSection title="Routing" description="Default worker settings">
      <SettingBlock
        label="Model"
        control={<input aria-label="Model" defaultValue="worker" />}
        hint="Used for implementation."
        cli="orch agent set"
      />
      <DisplayRow label="Branch" value="main" />
      <Copyable value="DEV-1378" />
    </FieldSection>
  ),
}
export const CompactCopy: StoryObj<typeof meta> = {
  render: () => <Copyable value="df33f44514" compact />,
  play: async ({ canvasElement }) => {
    const copy = within(canvasElement).getByRole('button', { name: 'Copy value' })
    const user = userEvent.setup()
    copy.focus()
    await user.keyboard('{Enter}')
    await expect(navigator.clipboard.readText()).resolves.toBe('df33f44514')
  },
}
