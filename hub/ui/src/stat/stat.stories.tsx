import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
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

/** A compact row reads as one line of figures; each figure's meaning opens from its (i). */
export const CompactWithAbout: StoryObj<typeof meta> = {
  render: () => (
    <StatRow compact>
      <StatTile
        label="in motion"
        figure="6.4 hours"
        about="How long any recorded work was in motion."
      />
      <StatTile label="agent cost" figure="$18.40" about="What the started agent work cost." />
    </StatRow>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'About agent cost' }))
    // The browser opens a popover on its own toggle, after the click returns.
    await waitFor(() => expect(canvas.getByText('What the started agent work cost.')).toBeVisible())
  },
}
