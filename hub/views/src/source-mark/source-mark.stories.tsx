import type { Meta, StoryObj } from '@storybook/react-vite'
import { SourceMark } from './source-mark'

const meta = {
  title: 'Views/SourceMark',
  component: SourceMark,
  args: { source: 'git', project: 'workshop' },
} satisfies Meta<typeof SourceMark>
export default meta
type Story = StoryObj<typeof meta>

export const Git: Story = {}
export const Tracker: Story = { args: { source: 'linear', protocol: 'linear' } }
