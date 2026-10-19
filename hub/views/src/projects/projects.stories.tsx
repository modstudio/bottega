import type { Meta, StoryObj } from '@storybook/react-vite'
import { PLATFORM_NAME } from '../../../../shared/brand'
import { HostedProjects } from './projects'

const meta = {
  title: 'Views/Projects',
  component: HostedProjects,
  args: {
    projects: [
      {
        spaceId: 'space-1',
        spaceName: 'Workshop',
        name: PLATFORM_NAME,
        stack: 'TypeScript',
        managedContext: true,
        landingBranch: 'main',
        keyPrefixes: ['DEV'],
        retiredAt: null,
      },
    ],
    colors: { [PLATFORM_NAME]: { light: '#315cbd', dark: '#8aabff' } },
    loaded: true,
    pending: false,
    error: null,
  },
} satisfies Meta<typeof HostedProjects>
export default meta
type Story = StoryObj<typeof meta>

export const Loaded: Story = {}
export const Empty: Story = { args: { projects: [] } }
