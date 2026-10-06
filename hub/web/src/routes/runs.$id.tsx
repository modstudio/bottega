import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type ReviewLens, ReviewLensList } from '@/components/review-lenses'
import { WaitingBadge } from '@/components/waiting-badge'
import { duration, relativeTime } from '@/lib/format'
import { isHostedMode } from '@/lib/hub-mode'
import { waitingByRun } from '@/lib/operator-waiting'
import { type OperatorWaitingItem, queryClient, trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button, IconButton } from '@/ui/button/button'
import { Companion } from '@/ui/companion/companion'
import { Input } from '@/ui/field/input'
import { DisplayRow } from '@/ui/form-layout/form-layout'
import { Segmented } from '@/ui/segmented/segmented'

const DELIVERIES = ['none', 'partial', 'full'] as const
const QUALITIES = ['wrong', 'mixed', 'right'] as const
const FIDELITIES = ['drifted', 'partial', 'faithful'] as const
type Delivery = (typeof DELIVERIES)[number]
type Quality = (typeof QUALITIES)[number]
type Fidelity = (typeof FIDELITIES)[number]
type RunDetail = {
  id: number | string
  root_id: number | string
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
  promptBytes?: number
  output: string | null
  delivery: Delivery | null
  quality: Quality | null
  fidelity: Fidelity | null
  note: string | null
  scored_at: string | null
  scoreAxes: readonly ('delivery' | 'quality' | 'fidelity')[]
  reviews: ReviewLens[]
}
type Verdict = {
  delivery: Delivery
  quality: Quality | null
  fidelity: Fidelity | null
  note: string | null
}

export const Route = createFileRoute('/runs/$id')({ component: RunDetailRoute })

function RunDetailRoute() {
  const { id } = Route.useParams()
  return <RunDetailPage id={id} />
}

function useRunDetail(id: string, numericId: number, hosted: boolean) {
  const hostedDetail = useQuery({
    ...trpc.record.run.queryOptions({ id }),
    enabled: hosted,
  })
  const localDetail = useQuery({
    ...trpc.run.get.queryOptions({ id: numericId }),
    enabled: !hosted,
  })
  return hosted ? hostedDetail : localDetail
}

function useWaitingItem(id: string, rootId: number | string, hosted: boolean) {
  const waiting = useQuery({
    ...trpc.operator.waiting.queryOptions(undefined, { refetchInterval: 20_000 }),
    enabled: !hosted,
  })
  return waitingByRun([{ id, root_id: rootId }], waiting.data ?? []).get(id)
}

function useRunScore(id: string, numericId: number, hosted: boolean, onSigned: () => void) {
  const onSuccess = async () => {
    const detailKey = hosted
      ? trpc.record.run.queryKey({ id })
      : trpc.run.get.queryKey({ id: numericId })
    const listKey = hosted ? trpc.record.runsView.queryKey() : trpc.run.list.queryKey()
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: detailKey }),
      queryClient.invalidateQueries({ queryKey: listKey }),
    ])
    onSigned()
  }
  const hostedScore = useMutation(trpc.record.score.mutationOptions({ onSuccess }))
  const localScore = useMutation(trpc.run.score.mutationOptions({ onSuccess }))
  return {
    score: hosted ? hostedScore : localScore,
    sign: (verdict: Verdict) => {
      if (hosted) hostedScore.mutate({ id, ...verdict })
      else localScore.mutate({ id: numericId, ...verdict })
    },
  }
}

function RunTranscript({ run, hosted }: { run: RunDetail; hosted: boolean }) {
  const promptLabel = hosted
    ? `Prompt excerpt (${run.promptBytes?.toLocaleString() ?? 'unknown'} bytes in the original prompt)`
    : 'Prompt'
  const reply = hosted
    ? '(Hosted records do not keep replies.)'
    : run.output || '(Nothing came back.)'
  return (
    <div className="grid gap-4 @2xl/panel:grid-cols-2">
      <DetailBlock label={promptLabel} value={run.prompt || '(Prompt unavailable.)'} />
      <DetailBlock label="Reply" value={reply} />
    </div>
  )
}

function RunStatusActions({ run, waiting }: { run: RunDetail; waiting?: OperatorWaitingItem }) {
  const running = run.status === 'running'
  const tone = running ? 'progress' : run.status !== 'ok' ? 'error' : 'neutral'
  return (
    <span className="flex items-center gap-2">
      {waiting ? <WaitingBadge item={waiting} /> : null}
      <Badge tone={tone} dot={running}>
        {run.status}
      </Badge>
    </span>
  )
}

function RunDetailPage({ id }: { id: string }) {
  const navigate = useNavigate()
  const hosted = isHostedMode()
  const numericId = Number(id)
  const detail = useRunDetail(id, numericId, hosted)
  const run = detail.data as unknown as RunDetail | undefined
  const waitingItem = useWaitingItem(id, run?.root_id ?? id, hosted)
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

  const { score, sign: signVerdict } = useRunScore(id, numericId, hosted, () => setAmending(false))

  const needsFidelity = Boolean(run?.scoreAxes.includes('fidelity') && delivery !== 'none')
  const canSign =
    delivery === 'none' || Boolean(delivery && quality && (!needsFidelity || fidelity))
  const sign = () => {
    if (!delivery || !canSign) return
    const verdict = {
      delivery,
      quality: delivery === 'none' ? null : quality,
      fidelity: needsFidelity ? fidelity : null,
      note: note || null,
    }
    signVerdict(verdict)
  }

  const close = () => void navigate({ to: '/runs', resetScroll: false })
  if (detail.isPending)
    return (
      <Companion onClose={close} title={`Run ${id}`} subtitle="Loading run...">
        <p className="text-text-muted">Loading...</p>
      </Companion>
    )
  if (detail.error)
    return (
      <Companion onClose={close} title={`Run ${id}`}>
        <p data-tone="error" className="text-status-text">
          Could not load this run. {detail.error.message}
        </p>
      </Companion>
    )
  if (!run) return null

  const subtitle = [
    run.agent,
    run.job,
    run.project ?? 'no project',
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
        <span className="min-w-0 flex-1 truncate text-text-muted">- {run.note}</span>
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
      actions={<RunStatusActions run={run} waiting={waitingItem} />}
      footer={signing}
    >
      <DisplayRow label="Agent" value={run.agent} />
      <DisplayRow label="Job" value={run.job} />
      <DisplayRow label="Project" value={run.project ?? 'no project'} />
      <DisplayRow label="Tokens" value={run.vendor_tokens?.toLocaleString() ?? '-'} />
      {run.probe ? (
        <p className="text-sm text-text-muted mb-3">Probe, not routing evidence.</p>
      ) : null}
      {run.evidence_excluded ? (
        <p className="text-sm text-text-muted mb-3">
          Not routing evidence: {run.evidence_excluded}
        </p>
      ) : null}
      {score.error ? (
        <p data-tone="error" className="mb-3 text-status-text">
          {score.error.message}
        </p>
      ) : null}
      {run.error ? (
        <DetailBlock label={run.status === 'ok' ? 'Outcome note' : 'Error'} value={run.error} />
      ) : null}
      <RunTranscript run={run} hosted={hosted} />
      <ReviewLensList lenses={run.reviews} />
    </Companion>
  )
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  const copy = () => void navigator.clipboard.writeText(value)
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-md font-semibold">{label}</h2>
        <IconButton size="sm" label={`Copy ${label.toLowerCase()}`} onClick={copy}>
          <Copy size={14} />
        </IconButton>
      </div>
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap border border-border-default bg-surface-sunken p-3 text-sm">
        {value}
      </pre>
    </section>
  )
}
