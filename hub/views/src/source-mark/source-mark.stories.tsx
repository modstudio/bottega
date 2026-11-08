import type { Meta, StoryObj } from '@storybook/react-vite'
import { SourceMark } from './source-mark'

const meta = {
  title: 'Views/SourceMark',
  component: SourceMark,
  args: { source: 'mcp', project: 'workshop', protocol: 'array-mcp' },
} satisfies Meta<typeof SourceMark>
export default meta
type Story = StoryObj<typeof meta>

export const ExternalTracker: Story = {}
export const Hub: Story = { args: { source: 'local' } }
export const NoTrackerRecord: Story = { args: { source: null, protocol: null } }
