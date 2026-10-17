import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { EditableTitle, EditorActions, EditorBand, EditorBanner } from './document-editor'

function Example() {
  const [title, setTitle] = useState('Editable title')
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich')
  return (
    <div>
      <EditableTitle title={title} onChange={setTitle} headingRef={() => {}} />
      <EditorBand toolbar={<span>Formatting</span>} mode={mode} onModeChange={setMode} />
      <EditorBanner conflict message={null} onReload={() => {}} />
      <EditorActions saveEnabled saving={false} onCancel={() => {}} onSave={() => {}} />
    </div>
  )
}

const meta = {
  title: 'Views/DocumentEditor',
  component: EditableTitle,
  args: { title: 'Editable title', onChange: () => {}, headingRef: () => {} },
} satisfies Meta<typeof EditableTitle>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const title = within(canvasElement).getByRole('textbox', { name: 'Title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'Changed title')
    await expect(title).toHaveValue('Changed title')
  },
}
export const Dark: Story = { globals: { theme: 'dark' } }
