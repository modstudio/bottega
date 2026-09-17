import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ProjectMark } from '@/components/design-system'
import { hostedProjectColors } from '@/components/hosted-projects'
import { type HostedLens, HostedLensList } from '@/components/hosted-reviews'
import { duration } from '@/lib/format'
import { trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Companion } from '@/ui/companion/companion'
import { DisplayRow } from '@/ui/form-layout/form-layout'

export function HostedRunDetail({ id }: { id: string }) {
  const navigate = useNavigate()
  const detail = useQuery(trpc.record.run.queryOptions({ id }))
  const projects = useQuery(trpc.record.projects.queryOptions())
  const colors = hostedProjectColors(projects.data ?? [])
  const close = () => void navigate({ to: '/runs', resetScroll: false })
  const run = detail.data
  const score = run?.score
  const scoreText = score
    ? [score.delivery, score.quality, score.fidelity].filter(Boolean).join(' · ')
    : null

  if (detail.isPending) {
    return (
      <Companion onClose={close} title={`Run ${id}`} subtitle="Loading run...">
        <p className="text-muted-foreground">Loading...</p>
      </Companion>
    )
  }
  if (detail.error || !run) {
    return (
      <Companion onClose={close} title={`Run ${id}`}>
        <p className="text-destructive">
          Could not load this run. {detail.error?.message ?? 'Not found'}
        </p>
      </Companion>
    )
  }

  const lenses = (run.reviews ?? []) as HostedLens[]
  return (
    <Companion
      onClose={close}
      title={`Run ${id}`}
      subtitle={[run.agent, run.job, run.projectName].filter(Boolean).join(' · ')}
      actions={<Badge>{run.status}</Badge>}
    >
      <DisplayRow label="Project" value={<ProjectMark name={run.projectName} colors={colors} />} />
      <DisplayRow label="Agent" value={run.agent} />
      <DisplayRow label="Job" value={run.job} />
      <DisplayRow label="Status" value={run.status} />
      <DisplayRow label="Started" value={run.startedAt} />
      <DisplayRow label="Latency" value={run.latencyMs == null ? '-' : duration(run.latencyMs)} />
      <DisplayRow
        label="Cost"
        value={run.vendorCostUsd == null ? '-' : `$${run.vendorCostUsd.toFixed(2)}`}
      />
      <DisplayRow label="Score" value={scoreText ?? 'Unscored'} />
      {score?.note ? <DisplayRow label="Score note" value={score.note} /> : null}
      {run.evidenceExcluded ? (
        <p className="meta mb-3">Not routing evidence: {run.evidenceExcluded}</p>
      ) : null}
      <DisplayRow label="Prompt" value={run.promptHead} />
      <HostedLensList lenses={lenses} />
    </Companion>
  )
}
