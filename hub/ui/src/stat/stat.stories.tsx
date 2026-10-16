import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { StatRow, StatTile } from './stat'

const meta: Meta = { title: 'Patterns/Stat', component: StatTile }
export default meta
export const States: StoryObj<typeof meta> = {
  render: () => (
    <StatRow>
      <StatTile label="Runs" figure="24" hint="This week" />
      <StatTile label="Active" figure="3" live />
      <StatTile
        label="Spend"
        breakdown={[
          { label: 'Codex', value: '$12.40' },
          { label: 'Claude', value: '$8.10' },
        ]}
        wrapHint
        hint="Separate provider totals"
      />
    </StatRow>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const codex = canvas.getByRole('button', { name: 'Codex: $12.40' })
    const claude = canvas.getByRole('button', { name: 'Claude: $8.10' })
    codex.focus()
    await userEvent.keyboard('{Tab}{Enter}')
    await expect(claude).toHaveAttribute('aria-pressed', 'true')
  },
}
