import type { Meta, StoryObj } from '@storybook/react-vite'
import { EmptyState } from './empty-state'

const meta: Meta = { title: 'Patterns/EmptyState', component: EmptyState } satisfies Meta<
  typeof EmptyState
>
export default meta
export const Default: StoryObj<typeof meta> = {
  args: {
    title: 'No runs yet',
    hint: 'Start a run to see it here.',
    action: <button type="button">Start run</button>,
  },
}
