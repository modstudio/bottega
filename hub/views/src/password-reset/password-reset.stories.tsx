import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { HostedResetPassword } from './password-reset'

const meta = {
  title: 'Views/PasswordReset',
  component: HostedResetPassword,
  args: {
    token: 'reset-token',
    resetPassword: fn(async () => {}),
    onResetComplete: fn(),
    requestAnotherHref: '/forgot-password',
  },
} satisfies Meta<typeof HostedResetPassword>
export default meta
type Story = StoryObj<typeof meta>

/** The route learns of a completed reset only through `onResetComplete`, and only on success. */
export const Ready: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText('New password'), 'correct horse battery')
    await userEvent.type(canvas.getByLabelText('Confirm new password'), 'correct horse battery')
    await userEvent.click(canvas.getByRole('button', { name: 'Reset password' }))
    await waitFor(() => expect(args.onResetComplete).toHaveBeenCalledOnce())
    await expect(args.resetPassword).toHaveBeenCalledWith('reset-token', 'correct horse battery')
  },
}

export const ResetRefused: Story = {
  args: { resetPassword: fn(async () => Promise.reject(new Error('Reset refused'))) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText('New password'), 'correct horse battery')
    await userEvent.type(canvas.getByLabelText('Confirm new password'), 'correct horse battery')
    await userEvent.click(canvas.getByRole('button', { name: 'Reset password' }))
    await expect(await canvas.findByText('Reset refused')).toBeVisible()
    await expect(args.onResetComplete).not.toHaveBeenCalled()
  },
}
export const Invalid: Story = { args: { invalid: true } }
