import { requestPasswordReset } from '@bottega/hub-data/hosted-auth'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedForgotPassword } from '@/components/hosted-password-reset'

export const Route = createFileRoute('/forgot-password')({
  component: function ForgotPasswordPage() {
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedForgotPassword requestPasswordReset={requestPasswordReset} />
  },
})
