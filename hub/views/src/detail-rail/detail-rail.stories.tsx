import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { DetailRail } from './detail-rail'

const meta = {
  title: 'Views/DetailRail',
  component: DetailRail,
  args: {
    label: 'Document information',
    defaultTab: 'hidden',
    top: <button type="button">Back to task</button>,
    tabs: [
      { value: 'hidden', label: 'Hidden', content: 'Hidden', hidden: true },
      { value: 'contents', label: 'Contents', content: 'Contents panel' },
      { value: 'details', label: 'Details', content: 'Details panel' },
    ],
  },
} satisfies Meta<typeof DetailRail>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('tab', { name: 'Details' }))
    await expect(canvas.getByText('Details panel')).toBeVisible()
  },
}
export const Dark: Story = { globals: { theme: 'dark' } }

function HiddenSelectedTab() {
  const [hideContents, setHideContents] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setHideContents(true)}>
        Hide contents
      </button>
      <DetailRail
        label="Document information"
        defaultTab="contents"
        tabs={[
          {
            value: 'contents',
            label: 'Contents',
            content: 'Contents panel',
            hidden: hideContents,
          },
          { value: 'details', label: 'Details', content: 'Fallback details panel' },
        ]}
      />
    </>
  )
}

export const SelectedTabBecomesHidden: Story = {
  render: () => <HiddenSelectedTab />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Hide contents' }))
    await expect(canvas.getByText('Fallback details panel')).toBeVisible()
  },
}
