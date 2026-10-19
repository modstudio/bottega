import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProjectMark } from './project-colors'

const meta = {
  title: 'Views/ProjectColors',
  component: ProjectMark,
  args: {
    name: 'workshop',
    colors: { workshop: { light: '#315cbd', dark: '#8aabff' } },
  },
} satisfies Meta<typeof ProjectMark>
export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
