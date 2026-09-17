import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DisplayRow } from '@/components/fields'
import { HostedRunDetail } from '@/components/hosted-run-detail'
import { duration, relativeTime } from '@/lib/format'
import { isHostedMode } from '@/lib/hub-mode'
import { queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button, IconButton } from '@/ui/button/button'
import { Companion } from '@/ui/companion/companion'
import { Input } from '@/ui/field/input'
import { Segmented } from '@/ui/segmented/segmented'

const DELIVERIES = ['none', 'partial', 'full'] as const
const QUALITIES = ['wrong', 'mixed', 'right'] as const
const FIDELITIES = ['drifted', 'partial', 'faithful'] as const
type Delivery = (typeof DELIVERIES)[number]
type Quality = (typeof QUALITIES)[number]
type Fidelity = (typeof FIDELITIES)[number]
type RunDetail = {
  id: number
  agent: string
  job: string
  project: string | null
  latency_ms: number | null
  vendor_tokens: number | null
  status: string
  failure_kind: string | null
  probe: boolean
  evidence_excluded: string | null
  error: string | null
  prompt: string | null
  output: string | null
  delivery: Delivery | null
  quality: Quality | null
  fidelity: Fidelity | null
  note: string | null
  scored_at: string | null
  scoreAxes: ('delivery' | 'quality' | 'fidelity')[]
}

export const Route = createFileRoute('/runs/$id')({ component: RunDetailRoute })

function RunDetailRoute() {
  const { id } = Route.useParams()
  if (isHostedMode()) return <HostedRunDetail id={id} />
  return <RunDetailPage id={id} />
}

function RunDetailPage({ id }: { id: string }) {
  const navigate = useNavigate()
  const numericId = Number(id)
  const detail = useQuery(trpc.run.get.queryOptions({ id: numericId }))
  const run = detail.data as RunDetail | undefined
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [quality, setQuality] = useState<Quality | null>(null)
  const [fidelity, setFidelity] = useState<Fidelity | null>(null)
  const [note, setNote] = useState('')
  const [amending, setAmending] = useState(false)

  useEffect(() => {
    if (!run) return
    setDelivery(run.delivery)
    setQuality(run.quality)
    setFidelity(run.fidelity)
    setNote(run.note ?? '')
  }, [run])

  const score = useMutation(
    trpc.run.score.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.run.get.queryKey({ id: numericId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.run.list.queryKey() }),
        ])
        setAmending(false)
      },
    }),
  )

  const needsFidelity = Boolean(run?.scoreAxes.includes('fidelity') && delivery !== 'none')
  const canSign =
    delivery === 'none' || Boolean(delivery && quality && (!needsFidelity || fidelity))
  const sign = () => {
    if (!delivery || !canSign) return
    score.mutate({
      id: numericId,
      delivery,
      quality: delivery === 'none' ? null : quality,
      fidelity: needsFidelity ? fidelity : null,
      note: note || null,
    })
  }

  const close = () => void navigate({ to: '/runs', resetScroll: false })
  if (detail.isPending)
    return (
      <Companion onClose={close} title={`Run ${id}`} subtitle="Loading run...">
        <p className="text-muted-foreground">Loading...</p>
      </Companion>
    )
  if (detail.error)
    return (
      <Companion onClose={close} title={`Run ${id}`}>
        <p className="text-destructive">Could not load this run. {detail.error.message}</p>
      </Companion>
    )
  if (!run) return null

  const running = run.status === 'running'
  const subtitle = [
    run.agent,
    run.job,
    run.project,
    run.latency_ms != null ? duration(run.latency_ms) : null,
  ]
    .filter(Boolean)
    .join(' \u00b7 ')
  const signed = Boolean(run.delivery && run.scored_at) && !amending
  const signing = signed ? (
    <div className="flex min-h-8 items-center gap-3">
      <strong>
        Signed {run.delivery}
        {run.quality ? ` \u00b7 ${run.quality}` : ''}
        {run.fidelity ? ` \u00b7 ${run.fidelity}` : ''}, {relativeTime(run.scored_at!)}
      </strong>
      {run.note ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">- {run.note}</span>
      ) : (
        <span className="flex-1" />
      )}
      <Button variant="secondary" size="sm" onClick={() => setAmending(true)}>
        Amend
      </Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-3">
      <strong>Sign this run</strong>
      <Segmented
        label="Delivery"
        value={delivery ?? ''}
        options={DELIVERIES.map((value) => ({ value, label: value }))}
        onChange={(value) => {
          const next = value as Delivery
          setDelivery(next)
          if (next === 'none') {
            setQuality(null)
            setFidelity(null)
          }
        }}
      />
      {delivery && delivery !== 'none' ? (
        <Segmented
          label="Quality"
          value={quality ?? ''}
          options={QUALITIES.map((value) => ({ value, label: value }))}
          onChange={(value) => setQuality(value as Quality)}
        />
      ) : null}
      {needsFidelity ? (
        <Segmented
          label="Fidelity"
          value={fidelity ?? ''}
          options={FIDELITIES.map((value) => ({ value, label: value }))}
          onChange={(value) => setFidelity(value as Fidelity)}
        />
      ) : null}
      <Input
        className="min-w-52 flex-1"
        placeholder="Add a note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <Button variant="primary" disabled={!canSign || score.isPending} onClick={sign}>
        {score.isPending ? 'Signing...' : 'Sign'}
      </Button>
    </div>
  )
  return (
    <Companion
      onClose={close}
      title={`Run ${id}`}
      subtitle={subtitle}
      actions={
        <Badge
          tone={running ? 'progress' : run.status !== 'ok' ? 'error' : 'neutral'}
          dot={running}
        >
          {run.status}
        </Badge>
      }
      footer={signing}
    >
      <DisplayRow label="Agent" value={run.agent} />
      <DisplayRow label="Job" value={run.job} />
      <DisplayRow label="Project" value={run.project ?? '-'} />
      <DisplayRow label="Tokens" value={run.vendor_tokens?.toLocaleString() ?? '-'} />
      {run.probe ? <p className="meta mb-3">Probe, not routing evidence.</p> : null}
      {run.evidence_excluded ? (
        <p className="meta mb-3">Not routing evidence: {run.evidence_excluded}</p>
      ) : null}
      {score.error ? (
        <p className="mb-3 text-destructive">
          Could not sign this run. {score.error.message} Check the selections and try again.
        </p>
      ) : null}
      {run.error ? <DetailBlock label="Error" value={run.error} /> : null}
      <div className="grid gap-4 @2xl/panel:grid-cols-2">
        <DetailBlock label="Prompt" value={run.prompt || '(Prompt unavailable.)'} />
        <DetailBlock label="Reply" value={run.output || '(Nothing came back.)'} />
      </div>
    </Companion>
  )
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  const copy = () => void navigator.clipboard.writeText(value)
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-sans text-[15px] font-semibold">{label}</h2>
        <IconButton size="sm" label={`Copy ${label.toLowerCase()}`} onClick={copy}>
          <Copy size={14} />
        </IconButton>
      </div>
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap border border-border bg-muted p-3 text-[12.5px]">
        {value}
      </pre>
    </section>
  )
}
