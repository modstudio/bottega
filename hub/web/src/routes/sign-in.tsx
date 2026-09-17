import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedSignIn } from '@/components/hosted-sign-in'
import { isHostedMode } from '@/lib/hub-mode'

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>) => ({ reset: search.reset === 'success' }),
  component: function SignInPage() {
    const search = Route.useSearch()
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedSignIn passwordChanged={search.reset} />
  },
})
