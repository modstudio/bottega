import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedResetPassword } from '@/components/hosted-password-reset'
import { isHostedMode } from '@/lib/hub-mode'

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
    invalid: search.error === 'INVALID_TOKEN',
  }),
  component: function ResetPasswordPage() {
    const search = Route.useSearch()
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedResetPassword token={search.token} invalid={search.invalid} />
  },
})
