import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { HistoryEntry } from './history-model'
import { TaskHistory } from './task-history'

const now = new Date('2026-10-16T15:00:00')
const shmuel = { name: 'Shmuel', kind: 'person' as const }
const claude = { name: 'Claude', kind: 'agent' as const }
const entries: HistoryEntry[] = [
  { kind: 'status', id: 's1', at: '2026-10-15T09:12:00', from: null, to: 'open', actor: shmuel },
  {
    kind: 'comment',
    id: 'c1',
    at: '2026-10-15T09:20:00',
    body: 'Starship borrows the **history feed** layout; keep our tokens and square corners.',
    actor: shmuel,
    canEdit: true,
    canDelete: true,
  },
  {
    kind: 'status',
    id: 's2',
    at: '2026-10-16T08:40:00',
    from: 'open',
    to: 'active',
    actor: claude,
  },
  {
    kind: 'run',
    id: 'r1',
    at: '2026-10-16T08:41:00',
    run: '13605',
    agent: 'codex',
    job: 'understand',
    endedAt: '2026-10-16T08:50:00',
    running: false,
  },
  {
    kind: 'status',
    id: 's3',
    at: '2026-10-16T11:02:00',
    from: 'active',
    to: 'review',
    actor: claude,
  },
  {
    kind: 'status',
    id: 's4',
    at: '2026-10-16T11:05:00',
    from: 'review',
    to: 'active',
    actor: claude,
  },
  {
    kind: 'run',
    id: 'r2',
    at: '2026-10-16T14:30:00',
    run: '14162',
    agent: 'codex',
    job: 'implement',
    endedAt: null,
    running: true,
  },
  {
    kind: 'comment',
    id: 'c2',
    at: '2026-10-16T14:45:00',
    body: 'Phase 4 is running; the page waits on its `TaskDetail` contract.',
    actor: shmuel,
    canEdit: true,
    canDelete: true,
  },
]
const comment = { run: () => undefined, pending: false, error: null }
const write = { run: () => undefined, pending: false, error: null }

const meta = {
  title: 'Views/TaskHistory',
  component: TaskHistory,
  args: { entries, comment, now, editComment: write, deleteComment: write },
} satisfies Meta<typeof TaskHistory>
export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Filtering: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '2 changes' }))
    await expect(canvas.getByText('review', { selector: 'span' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Comments' }))
    await expect(canvas.queryByText('Run #13605')).not.toBeInTheDocument()
    await expect(canvas.getByText(/Starship borrows/)).toBeVisible()
  },
}
export const Dark: Story = { globals: { theme: 'dark' } }
export const Composing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Add a comment' }))
    await expect(canvas.getByRole('button', { name: 'Comment' })).toBeDisabled()
  },
}
export const Refused: Story = {
  args: {
    comment: { ...comment, refused: 'This tracker does not accept comments from the dashboard.' },
  },
}
export const Empty: Story = { args: { entries: [] } }
export const Replying: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const action = canvas.getAllByRole('button', { name: 'Reply' })[0] as HTMLElement
    action.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByRole('button', { name: 'Comment' })).toBeEnabled()
  },
}
export const ConfirmingDelete: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const action = canvas.getAllByRole('button', { name: 'Delete' })[0] as HTMLElement
    action.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByText('Delete this comment?')).toBeVisible()
  },
}
