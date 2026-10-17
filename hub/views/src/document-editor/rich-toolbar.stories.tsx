import type { Meta, StoryObj } from '@storybook/react-vite'
import { RichToolbar } from './rich-toolbar'

const meta = { title: 'Views/RichToolbar', component: RichToolbar } satisfies Meta
export default meta
type Story = StoryObj
export const Light: Story = { render: () => <p>{RichToolbar.name}</p> }
export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => <p>{RichToolbar.name}</p>,
}
