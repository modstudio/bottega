import type { StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import { editorChrome as ArticleEditor, useArticleEditor } from './article-editor'

const doc = {
  id: 'guide',
  slug: 'guide',
  title: 'First run',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-18T12:00:00Z',
  scope: 'global',
  subject: null,
  audiences: ['internal'] as ['internal'],
  status: 'current' as const,
  kind: 'article' as const,
  summarySource: 'derived' as const,
  replacementSlug: null,
  delivery: 'demand' as const,
  body: 'Dispatch a run.',
}

function ArticleEditorStory() {
  const [editing, setEditing] = useState(false)
  const editor = useArticleEditor({
    doc,
    editing,
    onLeave: () => setEditing(false),
    storedDocument: { title: doc.title, body: doc.body, revision: null },
    saveAction: { run: fn(async () => ({})), pending: false, error: null, conflict: false },
    fetchCurrentArticle: async () => ({ title: doc.title, body: doc.body }),
    onLeaveRequest: fn(),
    leaveBlocker: { blocked: false, onKeep: fn(), onDiscard: fn() },
  })
  const chrome = ArticleEditor(editor, editing, true, () => setEditing(true))
  return (
    <>
      {chrome.headerAction}
      {chrome.bodyView}
      {editor.overlays}
    </>
  )
}

const meta = {
  title: 'Views/Docs/ArticleEditor',
  component: ArticleEditor,
  render: () => <ArticleEditorStory />,
}
export default meta
type Story = StoryObj
export const EntersEdit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Edit' }))
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeVisible()
  },
}
