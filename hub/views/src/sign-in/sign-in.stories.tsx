import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { HostedSignIn } from './sign-in'

const meta = {
  title: 'Views/Sign in',
  component: HostedSignIn,
  args: {
    passwordChanged: true,
    signInWithEmail: async () => undefined,
    onSuccess: fn(),
    renderForgotLink: (children, className) => (
      <a className={className} href="#forgot">
        {children}
      </a>
    ),
  },
} satisfies Meta<typeof HostedSignIn>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
