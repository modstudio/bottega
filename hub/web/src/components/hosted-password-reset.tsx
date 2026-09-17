import { useState } from 'react'
import { requestPasswordReset, resetPassword } from '@/lib/hosted-auth'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { PageHeader } from '@/ui/page-header/page-header'

const confirmation = 'If an account exists for that email, a password reset link has been sent.'

export function HostedForgotPassword() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setPending(true)
    try {
      await requestPasswordReset(email)
    } catch {
      // The confirmation is deliberately identical whether the request sent mail or not.
    } finally {
      setSubmitted(true)
      setPending(false)
    }
  }
  if (submitted)
    return (
      <>
        <PageHeader title="Check your email" />
        <p>{confirmation}</p>
      </>
    )
  return (
    <section>
      <PageHeader title="Forgot password" subtitle="Request a reset link" />
      <form className="max-w-sm space-y-4" onSubmit={(event) => void submit(event)}>
        <label htmlFor="reset-email" className="block space-y-1">
          <span>Email</span>
          <Input
            id="reset-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Sending...' : 'Send reset link'}
        </Button>
      </form>
    </section>
  )
}

export function validateResetPassword(password: string, confirmationValue: string) {
  if (password.length < 12) return 'Password must be at least 12 characters'
  if (password !== confirmationValue) return 'Passwords do not match'
  return null
}

export function HostedResetPassword({
  token,
  invalid = false,
}: {
  token?: string
  invalid?: boolean
}) {
  const [password, setPassword] = useState('')
  const [confirmationValue, setConfirmationValue] = useState('')
  const [error, setError] = useState<string | null>(
    invalid || !token ? 'This password reset link is invalid or has expired' : null,
  )
  const [pending, setPending] = useState(false)
  if (invalid || !token || error?.includes('invalid or has expired')) {
    return (
      <section>
        <PageHeader title="Reset link unavailable" />
        <p>This password reset link is invalid or has expired.</p>
        <p>
          <a href="/forgot-password" className="text-link hover:underline">
            Request another reset link
          </a>
        </p>
      </section>
    )
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const validation = validateResetPassword(password, confirmationValue)
    if (validation) return setError(validation)
    setPending(true)
    setError(null)
    try {
      await resetPassword(token, password)
      window.location.assign('/sign-in?reset=success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <section>
      <PageHeader title="Set a new password" />
      <form className="max-w-sm space-y-4" onSubmit={(event) => void submit(event)}>
        <label htmlFor="new-password" className="block space-y-1">
          <span>New password</span>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label htmlFor="confirm-password" className="block space-y-1">
          <span>Confirm new password</span>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmationValue}
            onChange={(event) => setConfirmationValue(event.target.value)}
          />
        </label>
        {error ? (
          <p data-tone="error" className="text-status-text">
            {error}
          </p>
        ) : null}
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Resetting...' : 'Reset password'}
        </Button>
      </form>
    </section>
  )
}
