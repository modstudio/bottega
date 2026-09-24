import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useState } from 'react'
import { isHostedMode } from '@/lib/hub-mode'
import { Button } from '@/ui/button/button'
import { PageHeader } from '@/ui/page-header/page-header'

export const Route = createFileRoute('/unsubscribe/$token')({ component: UnsubscribeRoute })

function UnsubscribeRoute() {
  const { token } = Route.useParams()
  if (!isHostedMode()) return <Navigate to="/" />
  return <UnsubscribePage token={token} />
}

function UnsubscribePage({ token }: { token: string }) {
  const details = useQuery({
    queryKey: ['report-unsubscribe', token],
    queryFn: async () => {
      const response = await fetch(`/v1/report-unsubscribe/${encodeURIComponent(token)}`)
      if (!response.ok) throw new Error('Could not load this unsubscribe link.')
      return (await response.json()) as {
        email: string
        subscription: string
        space: string
      } | null
    },
    retry: false,
  })
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(false)
  const unsubscribe = async () => {
    setPending(true)
    try {
      await fetch(`/unsubscribe/${encodeURIComponent(token)}`, { method: 'POST' })
      setDone(true)
    } finally {
      setPending(false)
    }
  }
  if (details.isPending) return <p>Loading subscription…</p>
  if (!details.data || done)
    return (
      <section>
        <PageHeader title="Already unsubscribed" />
        <p>This address is already unsubscribed.</p>
      </section>
    )
  return (
    <section>
      <PageHeader title="Unsubscribe from report" />
      <p>
        {details.data.email} will stop receiving the {details.data.subscription} for{' '}
        {details.data.space}.
      </p>
      <Button
        className="mt-4"
        variant="primary"
        disabled={pending}
        onClick={() => void unsubscribe()}
      >
        {pending ? 'Unsubscribing…' : 'Unsubscribe'}
      </Button>
    </section>
  )
}
