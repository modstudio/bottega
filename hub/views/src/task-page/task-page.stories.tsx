import { Dialog } from '@bottega/hub-ui/dialog'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import type { HistoryEntry } from '../task-history/history-model'
import { TaskHistory } from '../task-history/task-history'
import { TaskPage } from './task-page'
import type { TaskPageDoc } from './task-rail'

const now = new Date('2026-10-18T15:00:00')
const entries: HistoryEntry[] = [
  { kind: 'status', id: 's1', at: '2026-10-17T09:12:00', from: null, to: 'open', actor: 'Shmuel' },
  {
    kind: 'comment',
    id: 'c1',
    at: '2026-10-17T09:20:00',
    body: 'Open the task as a page; the sheet is too narrow for the description.',
    actor: 'Shmuel',
    canEdit: true,
    canDelete: true,
  },
  {
    kind: 'status',
    id: 's2',
    at: '2026-10-18T08:40:00',
    from: 'open',
    to: 'active',
    actor: 'Shmuel',
    agent: 'Claude',
  },
  {
    kind: 'run',
    id: 'r1',
    at: '2026-10-18T08:41:00',
    run: '14402',
    agent: 'codex',
    job: 'implement',
    endedAt: '2026-10-18T09:20:00',
    running: false,
  },
]

const action = { run: fn(async () => {}), pending: false, error: null }

const remoteBody = 'Someone else rewrote this description while you were editing.'

const body = `Open a single task as a full page, borrowing from Starship and reusing the docs page.

## Layout

- Title, key line and description, editable in the shared rich editor.
- A right rail with **Contents** and **Details** tabs.
- History at the bottom, with comments.

## Documents

Task documents open from Contents. Opening one replaces the rail with the document's details and a way back to the task.
`

const docs: TaskPageDoc[] = [
  {
    id: 'd1',
    label: 'DEV-1386-1',
    title: 'Plan',
    role: 'plan',
    body: '## Phases\n\nOne phase per pull request.\n\n## Risks\n\nThe rail must not hide the history.',
    keyLine: [
      { key: 'role', content: 'Plan' },
      { key: 'version', content: 'Version 3' },
      { key: 'updated', content: 'Updated 2 hours ago' },
    ],
    facts: [
      { label: 'Role', value: 'plan' },
      { label: 'Version', value: '3' },
      { label: 'Updated', value: '2 hours ago' },
    ],
  },
  {
    id: 'd2',
    label: 'DEV-1386-2',
    title: 'Starship comparison',
    role: null,
    body: 'What Starship does with history, and what we keep.',
    keyLine: [{ key: 'updated', content: 'Updated yesterday' }],
    facts: [
      { label: 'Version', value: '1' },
      { label: 'Updated', value: 'yesterday' },
    ],
  },
]

function Page({
  refused,
  conflict = false,
  framed = false,
  onClose = () => {},
}: {
  refused?: string
  conflict?: boolean
  framed?: boolean
  onClose?: () => void
}) {
  const [openDoc, setOpenDoc] = useState<string | null>(null)
  const page = (
    <TaskPage
      crumbs={[
        { key: 'project', label: 'workshop' },
        { key: 'task', label: 'DEV-1386' },
      ]}
      title="Open a task as a full page"
      body={body}
      keyLine={[
        { key: 'status', content: 'Active' },
        { key: 'assignee', content: 'Shmuel' },
        { key: 'updated', content: 'Updated 2 hours ago' },
      ]}
      details={[
        { label: 'Status', value: 'Active' },
        { label: 'Assignee', value: 'Shmuel' },
        { label: 'Parent', value: '—' },
        { label: 'Source', value: 'hub' },
        { label: 'Updated', value: '2 hours ago' },
      ]}
      docs={docs}
      openDoc={openDoc}
      onOpenDoc={setOpenDoc}
      history={
        <TaskHistory
          entries={entries}
          now={now}
          comment={action}
          editComment={action}
          deleteComment={action}
        />
      }
      save={{
        run: fn(async () => true),
        pending: false,
        error: null,
        refused,
        conflict,
        reload: fn(async () => ({ title: 'Open a task as a full page', body: remoteBody })),
      }}
      onClose={onClose}
    />
  )
  // The dashboard opens the page inside a full dialog, so a nested dialog's close must not reach it.
  return framed ? (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="Task"
      size="full"
      variant="chromeless"
    >
      {page}
    </Dialog>
  ) : (
    page
  )
}

const meta: Meta = {
  title: 'Views/TaskPage',
  component: TaskPage,
  parameters: { layout: 'fullscreen' },
  render: (args) => <Page {...args} />,
}
export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}

export const Dark: Story = { globals: { theme: 'dark' } }

export const ReadOnly: Story = { args: { refused: 'This tracker does not take task edits.' } }

export const OpensADocument: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: /Plan/ }))
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Back to task' }))
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'Open a task as a full page' }),
    ).toBeVisible()
  },
}

/** Closing over an unsaved draft asks first, and keeping it leaves the draft in place. */
export const GuardsADraft: Story = {
  args: { onClose: fn(), framed: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getAllByRole('button', { name: 'Edit' })[0]!)
    const title = await canvas.findByRole('textbox', { name: 'Title' })
    await userEvent.type(title, ' draft')
    await userEvent.click(canvas.getByRole('button', { name: 'Close task' }))
    const ask = await canvas.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await userEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }))
    // The browser turns Escape into the page dialog's cancel, which must ask rather than close.
    canvas
      .getByRole('dialog', { name: 'Task' })
      .dispatchEvent(new Event('cancel', { cancelable: true }))
    const escaped = await canvas.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await userEvent.click(within(escaped).getByRole('button', { name: 'Keep editing' }))
    // Opening a document leaves the draft, so it asks too.
    await userEvent.click(canvas.getAllByRole('button', { name: /Plan/ })[0]!)
    const switched = await canvas.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await userEvent.click(within(switched).getByRole('button', { name: 'Keep editing' }))
    await expect(canvas.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Open a task as a full page draft',
    )
    await expect(args.onClose).not.toHaveBeenCalled()
  },
}

/** Reloading after a conflict restarts the draft from the stored task, not the stale one. */
export const ReloadsAfterConflict: Story = {
  args: { conflict: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getAllByRole('button', { name: 'Edit' })[0]!)
    await userEvent.click(await canvas.findByRole('button', { name: 'Reload' }))
    await expect(await canvas.findByText(remoteBody)).toBeVisible()
  },
}
