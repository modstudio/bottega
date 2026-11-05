import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { InstructionsView } from './instructions-view'

const onSelect = fn()
const entry = {
  slug: 'AGENTS.md',
  title: 'Global instructions',
  delivery: 'inject' as const,
  updatedAt: '2026-11-02T12:00:00Z',
  reach: [
    { agent: 'Claude Code', path: '~/.claude/CLAUDE.md' },
    { agent: 'Codex', path: '~/.codex/AGENTS.md' },
    { agent: 'Grok', path: '~/.grok/AGENTS.md' },
  ],
}
const reference = {
  slug: 'servers',
  title: 'Servers',
  delivery: 'demand' as const,
  updatedAt: '2026-10-30T12:00:00Z',
  reach: [],
}

const meta = {
  title: 'Views/Docs/Instructions',
  component: InstructionsView,
  parameters: { layout: 'fullscreen' },
  args: {
    items: [entry, reference],
    selectedSlug: 'AGENTS.md',
    onSelect,
    doc: {
      ...entry,
      body: '<!-- Generated; edit elsewhere -->\n# Your role\n\nYou design the change and judge the result.',
    },
    loading: false,
  },
} satisfies Meta<typeof InstructionsView>

export default meta
type Story = StoryObj<typeof meta>

export const Reading: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('~/.codex/AGENTS.md')).toBeInTheDocument()
    await expect(canvas.queryByText(/Generated; edit elsewhere/)).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: /Servers/ }))
    await expect(onSelect).toHaveBeenCalledWith('servers')
  },
}

export const NoReferences: Story = {
  args: { items: [entry] },
}
