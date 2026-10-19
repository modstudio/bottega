import type { Meta, StoryObj } from '@storybook/react-vite'
import { DocStatusBadge } from './status-badge'

const meta = { title: 'Views/Docs/StatusBadge', component: DocStatusBadge } satisfies Meta<
  typeof DocStatusBadge
>
export default meta
type Story = StoryObj<typeof meta>
export const Archived: Story = { args: { status: 'archived' } }
