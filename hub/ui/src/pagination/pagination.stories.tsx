import type { Meta, StoryObj } from '@storybook/react-vite'
import { useArgs } from 'storybook/preview-api'
import { expect, userEvent, within } from 'storybook/test'
import { Pagination } from './pagination'

const meta: Meta = {
  title: 'Patterns/Pagination',
  component: Pagination,
  args: { page: 1, pageSize: 25, total: 63, onPageChange: () => {}, onPageSizeChange: () => {} },
}
export default meta
function Controlled(args: StoryObj<typeof meta>['args']) {
  const [, updateArgs] = useArgs()
  return (
    <Pagination
      {...(args as Parameters<typeof Pagination>[0])}
      onPageChange={(page) => updateArgs({ page })}
    />
  )
}
export const KnownTotal: StoryObj<typeof meta> = { render: Controlled }
export const Cursor: StoryObj<typeof meta> = {
  args: { total: undefined, hasNext: true, onPageSizeChange: undefined },
}
export const Empty: StoryObj<typeof meta> = { args: { total: 0 } }
export const Keyboard: StoryObj<typeof meta> = {
  render: () => (
    <>
      <Pagination
        page={1}
        pageSize={25}
        total={63}
        onPageChange={(page) => {
          const output = document.querySelector('output[data-page]')
          if (output) output.textContent = `Page ${page}`
        }}
      />
      <output data-page="">Page 1</output>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const next = canvas.getByRole('button', { name: 'Next page' })
    next.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByText('Page 2')).toBeVisible()
  },
}
