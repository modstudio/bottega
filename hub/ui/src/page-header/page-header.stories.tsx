import type { Meta, StoryObj } from '@storybook/react-vite'
import { PageHeader, SectionTitle } from './page-header'

const meta: Meta = { title: 'Patterns/PageHeader', component: PageHeader } satisfies Meta<
  typeof PageHeader
>
export default meta
export const Default: StoryObj<typeof meta> = {
  args: {
    title: 'Runs',
    subtitle: 'This machine',
    actions: <button type="button">Start run</button>,
  },
}
export const Section: StoryObj<typeof meta> = {
  render: () => <SectionTitle detail="24 total">Recent runs</SectionTitle>,
}
