import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { NarrowFacts, type TaskPageDoc, TaskRail } from './task-rail'

const docs: TaskPageDoc[] = [
  {
    id: 'd1',
    label: 'DEV-1386/1',
    title: 'Survey: inventory and migration shape for UUID identity',
    role: 'survey',
    body: '## Phases\n\nOne.\n\n## Risks\n\nTwo.',
    facts: [
      { label: 'Document', value: 'DEV-1386/1' },
      { label: 'Role', value: 'survey' },
    ],
    keyLine: [],
  },
  {
    id: 'd2',
    label: 'DEV-1386/2',
    title: 'Plan',
    role: null,
    body: 'No sections.',
    facts: [{ label: 'Document', value: 'DEV-1386/2' }],
    keyLine: [],
  },
]

const details = [
  { label: 'Status', value: 'Active' },
  { label: 'Assignee', value: 'Unassigned' },
]

const meta: Meta = {
  title: 'Views/TaskRail',
  component: TaskRail,
  parameters: { layout: 'padded' },
  args: { openDoc: null, onOpenDoc: fn() },
  render: (args) => {
    const doc = docs.find((candidate) => candidate.id === args.openDoc) ?? null
    const rail = { doc, docs, details, onOpenDoc: args.onOpenDoc }
    return (
      <>
        <TaskRail {...rail} body={'## Objective\n\nText.\n\n## Context\n\nMore.'} />
        <NarrowFacts {...rail} />
      </>
    )
  },
}
export default meta
type Story = StoryObj<typeof meta>

export const Task: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getAllByRole('button', { name: /Survey: inventory/ })[0]!)
    await expect(args.onOpenDoc).toHaveBeenCalledWith('d1')
  },
}

export const OpenDocument: Story = {
  args: { openDoc: 'd1' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getAllByRole('button', { name: 'Back to task' })[0]!)
    await expect(args.onOpenDoc).toHaveBeenCalledWith(null)
  },
}

export const Dark: Story = { globals: { theme: 'dark' } }
