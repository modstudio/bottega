import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { HistoryComment } from './history-comment'

const write = { run: () => undefined, pending: false, error: null }

const meta = {
  title: 'Views/HistoryComment',
  component: HistoryComment,
  args: {
    id: 'c1',
    at: '2026-10-16T14:45:00',
    time: '14:45',
    body: 'Phase 4 is running; the page waits on its `TaskDetail` contract.',
    author: 'Shmuel',
    canEdit: true,
    canDelete: true,
    editing: false,
    onReply: () => undefined,
    onEditStart: () => undefined,
    onEditEnd: () => undefined,
    edit: write,
    onDelete: () => undefined,
  },
} satisfies Meta<typeof HistoryComment>
export default meta
type Story = StoryObj<typeof meta>

export const Actions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    canvas.getByRole('button', { name: 'Delete' }).focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByText('Delete this comment?')).toBeVisible()
  },
}
export const ReplyOnly: Story = { args: { canEdit: false, canDelete: false } }
export const Editing: Story = { args: { editing: true } }
export const Narrow: Story = {
  decorators: [(story) => <div style={{ width: 320 }}>{story()}</div>],
}
export const DeleteFailed: Story = {
  args: { deleteError: 'The tracker refused the delete: the comment is older than a day.' },
}
