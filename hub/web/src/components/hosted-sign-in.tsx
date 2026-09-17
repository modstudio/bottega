import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '@/components/design-system'
import { signInWithEmail } from '@/lib/hosted-auth'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'

export function HostedSignIn() {
  const navigate = useNavigate()
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
      await navigate({ to: '/runs' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section>
      <PageHeader title="Sign in" subtitle="Record session" />
      <form className="max-w-sm space-y-4" onSubmit={(event) => void submit(event)}>
        <label htmlFor="hosted-email" className="block space-y-1">
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
        <label htmlFor="hosted-password" className="block space-y-1">
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
        {error ? <p className="text-destructive">{error}</p> : null}
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </section>
  )
}
