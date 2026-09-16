import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedSignIn } from '@/components/hosted-sign-in'
import { isHostedMode } from '@/lib/hub-mode'

export const Route = createFileRoute('/sign-in')({
  component: function SignInPage() {
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedSignIn />
  },
})
