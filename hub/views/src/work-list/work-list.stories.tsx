import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { BoardView, TaskContent } from './work-list'

const meta = {
  title: 'Views/Work list',
  component: TaskContent,
  args: {
    name: 'flight',
    data: {
      rows: [],
      dropped: [],
      unmappedStatuses: { count: 0, words: [] },
      facets: { projects: [], agents: [], sources: [] },
    },
    fetchedAt: Date.now(),
    filters: null,
    filtersActive: 0,
    filtered: false,
    filterAgent: '',
    onOpenTask: fn(),
    waitingByRun: new Map(),
    renderWaiting: () => null,
  },
} satisfies Meta<typeof TaskContent>
export default meta
type Story = StoryObj<typeof meta>

const boardResponse = {
  engaged: '2h',
  activeAgents: [],
  tasksShipped: 3,
  collectedAt: '2026-10-19T12:00:00.000Z',
  servingSince: '2026-10-19T10:00:00.000Z',
  counts: { flight: 0, done: 3, runs: 0 },
  data: {
    cards: [],
    totals: { status: {}, project: {} },
    scoped: false,
    filters: { project: '' },
    facets: { projects: [], agents: [], sources: [] },
  },
}

export const Board: Story = {
  render: () => (
    <BoardView
      response={boardResponse}
      pending={false}
      error={null}
      renderChrome={() => null}
      onOpenTask={fn()}
      settings={{ layout: 'cards', group: 'status' }}
      search=""
      onSearchChange={fn()}
      onSettingsChange={fn()}
      why
      onWhyChange={fn()}
      phone={false}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'why these cards?' }))
    await expect(canvas.getByText(/A card is here because/)).toBeVisible()
  },
}
