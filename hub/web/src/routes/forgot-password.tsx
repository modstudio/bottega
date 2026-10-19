import { requestPasswordReset } from '@bottega/hub-data/hosted-auth'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { HostedForgotPassword } from '@bottega/hub-views/password-reset'
import { createFileRoute, Navigate } from '@tanstack/react-router'

export const Route = createFileRoute('/forgot-password')({
  component: function ForgotPasswordPage() {
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedForgotPassword requestPasswordReset={requestPasswordReset} />
  },
})
