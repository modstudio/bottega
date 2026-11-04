import type { Meta, StoryObj } from '@storybook/react-vite'
import { ErrorState } from './error-state'

const meta: Meta = { title: 'Patterns/ErrorState', component: ErrorState } satisfies Meta<
  typeof ErrorState
>
export default meta
type Story = StoryObj<typeof meta>

export const TitleOnly: Story = {
  args: { title: 'Could not load the inbox' },
}

export const WithMessage: Story = {
  args: { title: 'Could not load the inbox', message: 'The service did not respond.' },
}
