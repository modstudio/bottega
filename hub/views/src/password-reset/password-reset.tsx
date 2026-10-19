import { Button } from '@bottega/hub-ui/button'
import { Input } from '@bottega/hub-ui/field/input'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { useState } from 'react'
import { passwordResetStyles } from './password-reset.styles.ts'

const confirmation = 'If an account exists for that email, a password reset link has been sent.'

export function HostedForgotPassword({
  requestPasswordReset,
}: {
  requestPasswordReset: (email: string) => Promise<void>
}) {
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
      <form className={passwordResetStyles().form()} onSubmit={(event) => void submit(event)}>
        <label htmlFor="reset-email" className={passwordResetStyles().label()}>
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
  resetPassword,
  onResetComplete,
  requestAnotherHref,
}: {
  token?: string
  invalid?: boolean
  resetPassword: (token: string, newPassword: string) => Promise<void>
  onResetComplete: () => void
  /** Where a reader asks for a new link when this one is unusable; the route owns the address. */
  requestAnotherHref: string
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
          <a href={requestAnotherHref} className={passwordResetStyles().link()}>
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
      onResetComplete()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <section>
      <PageHeader title="Set a new password" />
      <form className={passwordResetStyles().form()} onSubmit={(event) => void submit(event)}>
        <label htmlFor="new-password" className={passwordResetStyles().label()}>
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
        <label htmlFor="confirm-password" className={passwordResetStyles().label()}>
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
          <p data-tone="error" className={passwordResetStyles().error()}>
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
