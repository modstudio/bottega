import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useState } from 'react'
import { signInWithEmail, signOutFromRecord } from '@/lib/hosted-auth'
import {
  acceptOrganizationInvitation,
  getOrganizationInvitation,
  OrganizationRequestError,
  recordAuthSession,
  rejectOrganizationInvitation,
  setActiveOrganization,
  signUpForRecord,
} from '@/lib/hosted-organization'
import { isHostedMode } from '@/lib/hub-mode'
import { Button } from '@/ui/button/button'
import { Input } from '@/ui/field/input'
import { PageHeader } from '@/ui/page-header/page-header'

export const Route = createFileRoute('/accept-invitation/$id')({ component: InvitationRoute })

const invalidMessage =
  'This invitation is no longer valid. It may have expired, been cancelled, or already been used. Ask the person who invited you to send a new one.'

function InvitationRoute() {
  const { id } = Route.useParams()
  if (!isHostedMode()) return <Navigate to="/" />
  return <InvitationPage id={id} />
}

function InvitationPage({ id }: { id: string }) {
  const session = useQuery({
    queryKey: ['record-auth-session'],
    queryFn: recordAuthSession,
    retry: false,
  })
  const [version, setVersion] = useState(0)
  if (session.isPending) return <p>Checking your invitation…</p>
  if (!session.data)
    return (
      <SignedOutInvitation
        onAuthenticated={() => {
          setVersion((value) => value + 1)
          void session.refetch()
        }}
      />
    )
  return <SignedInInvitation key={version} id={id} email={session.data.user.email} />
}

function SignedOutInvitation({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<'sign-in' | 'create'>('sign-in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      if (mode === 'sign-in') await signInWithEmail(email, password)
      else await signUpForRecord(name, email, password)
      onAuthenticated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <section>
      <PageHeader title="Accept invitation" subtitle="Sign in or create an account to continue" />
      <div className="mb-5 flex gap-2">
        <Button
          variant={mode === 'sign-in' ? 'primary' : 'secondary'}
          onClick={() => setMode('sign-in')}
        >
          Sign in
        </Button>
        <Button
          variant={mode === 'create' ? 'primary' : 'secondary'}
          onClick={() => setMode('create')}
        >
          Create account
        </Button>
      </div>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        {mode === 'create' ? (
          <label htmlFor="invitation-name" className="block space-y-1">
            <span>Name</span>
            <Input
              id="invitation-name"
              required
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : null}
        <label htmlFor="invitation-email" className="block space-y-1">
          <span>Email</span>
          <Input
            id="invitation-email"
            required
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label htmlFor="invitation-password" className="block space-y-1">
          <span>Password</span>
          <Input
            id="invitation-password"
            required
            minLength={12}
            type="password"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p data-tone="error" className="text-status-text">
            {error}
          </p>
        ) : null}
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Continuing…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
    </section>
  )
}

function SignedInInvitation({ id, email }: { id: string; email: string }) {
  const invitation = useQuery({
    queryKey: ['organization-invitation', id],
    queryFn: () => getOrganizationInvitation(id),
    retry: false,
  })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [declined, setDeclined] = useState(false)
  if (invitation.isPending) return <p>Loading invitation…</p>
  if (invitation.error) {
    const mismatch =
      invitation.error instanceof OrganizationRequestError && invitation.error.status === 403
    return (
      <section>
        <PageHeader title="Accept invitation" />
        {mismatch ? (
          <>
            <p>
              This invitation was sent to a different email address. You are signed in as {email}.
            </p>
            <Button
              className="mt-4"
              onClick={() => void signOutFromRecord().then(() => window.location.reload())}
            >
              Sign out
            </Button>
          </>
        ) : (
          <p>{invalidMessage}</p>
        )}
      </section>
    )
  }
  if (declined)
    return (
      <section>
        <PageHeader title="Invitation declined" />
        <p>You declined the invitation to {invitation.data.organizationName}.</p>
      </section>
    )
  const act = async (operation: 'accept' | 'decline') => {
    setError(null)
    setPending(true)
    try {
      if (operation === 'accept') {
        const accepted = await acceptOrganizationInvitation(id)
        await setActiveOrganization(accepted.invitation.organizationId)
        window.location.assign('/')
      } else {
        await rejectOrganizationInvitation(id)
        setDeclined(true)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <section>
      <PageHeader
        title={`Join ${invitation.data.organizationName}`}
        subtitle={`Invitation for ${email}`}
      />
      <p>
        {invitation.data.inviterEmail} invited you to join as {invitation.data.role}.
      </p>
      {error ? (
        <p data-tone="error" className="mt-4 text-status-text">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex gap-2">
        <Button variant="primary" disabled={pending} onClick={() => void act('accept')}>
          Accept
        </Button>
        <Button disabled={pending} onClick={() => void act('decline')}>
          Decline
        </Button>
      </div>
    </section>
  )
}
