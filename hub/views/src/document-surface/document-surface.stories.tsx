import type { Meta, StoryObj } from '@storybook/react-vite'
import { type Ref, useState } from 'react'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { DocumentSurface, DocumentTitle } from './document-surface'

function SwappingHeadingSurface() {
  const [editing, setEditing] = useState(false)
  const title = 'A document title'
  return (
    <DocumentSurface
      crumbs={[{ key: 'guide', label: 'Guide' }]}
      title={title}
      heading={(ref) =>
        editing ? (
          <input
            ref={ref as Ref<HTMLInputElement>}
            aria-label="Document title"
            value={title}
            readOnly
          />
        ) : (
          <DocumentTitle ref={ref} title={title} />
        )
      }
      headerActions={
        <button type="button" onClick={() => setEditing(true)}>
          Edit heading
        </button>
      }
      body={<div style={{ height: 900 }}>Document body</div>}
    />
  )
}

const meta = {
  title: 'Views/DocumentSurface',
  component: DocumentSurface,
  args: {
    crumbs: [{ key: 'guide', label: 'Guide' }],
    title: 'A document title',
    heading: (ref) => <DocumentTitle ref={ref} title="A document title" />,
    keyLine: <p>Updated today</p>,
    body: <div style={{ height: 900 }}>Document body</div>,
    wide: false,
    onWideChange: fn(),
  },
} satisfies Meta<typeof DocumentSurface>
export default meta
type Story = StoryObj<typeof meta>
export const Light: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Wide' }))
    const surface = canvasElement.querySelector('main')
    const expected = document.createElement('span')
    expected.style.backgroundColor = 'var(--color-surface-page)'
    canvasElement.append(expected)
    await expect(surface).not.toBeNull()
    const background = getComputedStyle(surface as HTMLElement).backgroundColor
    await expect(background).not.toBe('rgba(0, 0, 0, 0)')
    await expect(background).toBe(getComputedStyle(expected).backgroundColor)
    expected.remove()
  },
}
export const TitleBehindBar: Story = {
  play: async ({ canvasElement }) => {
    const heading = canvasElement.querySelector('h1')
    heading?.scrollIntoView({ block: 'start' })
    window.scrollBy(0, 300)
    await waitFor(() =>
      expect(within(canvasElement).getAllByText('A document title')).toHaveLength(2),
    )
    const wide = within(canvasElement).getByRole('button', { name: 'Wide' })
    await userEvent.click(wide)
    await expect(meta.args.onWideChange).toHaveBeenCalledWith(true)
  },
}
export const Dark: Story = { globals: { theme: 'dark' } }
export const SwappedHeadingElement: Story = {
  render: () => <SwappingHeadingSurface />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Edit heading' }))
    const heading = within(canvasElement).getByRole('textbox', { name: 'Document title' })
    await expect(heading.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    const stickyBar = canvasElement.querySelector('main > div')
    await expect(stickyBar).not.toBeNull()
    await expect(
      within(stickyBar as HTMLElement).queryByText('A document title'),
    ).not.toBeInTheDocument()
  },
}
