import { Button } from '@bottega/hub-ui/button'
import { Input } from '@bottega/hub-ui/field/input'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { type ReactNode, useState } from 'react'
import { signInStyles } from './sign-in.styles.ts'

export function HostedSignIn({
  passwordChanged = false,
  signInWithEmail,
  onSuccess,
  renderForgotLink,
}: {
  passwordChanged?: boolean
  signInWithEmail: (email: string, password: string) => Promise<void>
  onSuccess(): void | Promise<void>
  renderForgotLink(children: ReactNode, className: string): ReactNode
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      await signInWithEmail(email, password)
      await onSuccess()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section>
      <PageHeader title="Sign in" subtitle="Record session" />
      {passwordChanged ? (
        <p className={signInStyles().notice()}>
          Your password has been changed. Sign in with your new password.
        </p>
      ) : null}
      <form className={signInStyles().form()} onSubmit={(event) => void submit(event)}>
        <label htmlFor="hosted-email" className={signInStyles().label()}>
          <span>Email</span>
          <Input
            id="hosted-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label htmlFor="hosted-password" className={signInStyles().label()}>
          <span>Password</span>
          <Input
            id="hosted-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p data-tone="error" className={signInStyles().error()}>
            {error}
          </p>
        ) : null}
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Signing in...' : 'Sign in'}
        </Button>
        <p>{renderForgotLink('Forgot password?', signInStyles().link())}</p>
      </form>
    </section>
  )
}
