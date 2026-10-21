import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { CodeSection } from './code-section'

const meta = {
  title: 'Views/Docs/CodeSection',
  component: CodeSection,
  args: { count: 2, children: <p>orchestrator/src/run.ts</p> },
} satisfies Meta<typeof CodeSection>
export default meta
type Story = StoryObj<typeof meta>
export const Opens: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /In the code/ }))
    await expect(canvas.getByText('orchestrator/src/run.ts')).toBeVisible()
  },
}
