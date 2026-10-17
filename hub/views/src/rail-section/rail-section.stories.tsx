import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { RailSection } from './rail-section'

const meta = {
  title: 'Views/RailSection',
  component: RailSection,
  args: { label: 'Details', count: 3, defaultOpen: true, children: <p>Section content</p> },
} satisfies Meta<typeof RailSection>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: /Details/ })
    await userEvent.click(button)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
  },
}
export const Dark: Story = { globals: { theme: 'dark' } }
