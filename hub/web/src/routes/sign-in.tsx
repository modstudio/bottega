import { signInWithEmail } from '@bottega/hub-data/hosted-auth'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { HostedSignIn } from '@bottega/hub-views/sign-in'
import { createFileRoute, Link, Navigate, useNavigate } from '@tanstack/react-router'

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>) => ({ reset: search.reset === 'success' }),
  component: function SignInPage() {
    const search = Route.useSearch()
    const navigate = useNavigate()
    if (!isHostedMode()) return <Navigate to="/" />
    return (
      <HostedSignIn
        passwordChanged={search.reset}
        signInWithEmail={signInWithEmail}
        onSuccess={() => navigate({ to: '/runs' })}
        renderForgotLink={(children, className) => (
          <Link to="/forgot-password" className={className}>
            {children}
          </Link>
        )}
      />
    )
  },
})
