import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedForgotPassword } from '@/components/hosted-password-reset'
import { isHostedMode } from '@bottega/hub-data/hub-mode'

export const Route = createFileRoute('/forgot-password')({
  component: function ForgotPasswordPage() {
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedForgotPassword />
  },
})
