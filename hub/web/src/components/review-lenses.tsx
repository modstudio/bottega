import { Badge } from '@bottega/hub-ui/badge'
import { Button } from '@bottega/hub-ui/button'
import { Companion } from '@bottega/hub-ui/companion'
import { DisplayRow, FieldSection } from '@bottega/hub-ui/form-layout'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { runEasternTime } from '@bottega/hub-util/format'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { type ProjectColors, ProjectMark } from '@/components/design-system'
import { useDetailPanel } from '@/lib/detail-panel'
import type {
  RunDetailReviewFinding,
  RunDetailReviewLens,
} from '../../../../shared/review-presentation.ts'

type HostedReview = {
  id: string
  spaceName: string
  recordedAt: string
  projectName?: string | null
  completedAt?: string | null
  tier?: number | null
  lensCount?: number
  findingCount?: number
}

export function ReviewLensList({ lenses }: { lenses: RunDetailReviewLens[] }) {
  if (!lenses.length) return <p className="mt-4 text-text-muted">No review lenses.</p>
  return (
    <div className="mt-4 space-y-6">
      {lenses.map((lens, index) => {
        const findings = lens.findings
        return (
          <FieldSection
            key={lens.id}
            title={lens.lens || `Lens ${index + 1}`}
            description={lens.agent}
          >
            {findings.length ? (
              findings.map((finding: RunDetailReviewFinding) => {
                return (
                  <div key={finding.id} className="border border-border-default p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge>{finding.severity}</Badge>
                      <span className="text-text-muted">{finding.location}</span>
                    </div>
                    <p>{finding.evidence}</p>
                    {finding.proposedCorrection ? (
                      <p className="mt-2 text-text-muted">{finding.proposedCorrection}</p>
                    ) : null}
                  </div>
                )
              })
            ) : (
              <p className="text-text-muted">No findings.</p>
            )}
          </FieldSection>
        )
      })}
    </div>
  )
}

export function HostedReviews({
  rows,
  colors,
  pending,
  loadMore,
}: {
  rows: HostedReview[]
  colors: ProjectColors
  pending: boolean
  loadMore: { run(): void; pending: boolean; error: string | null; available: boolean }
}) {
  const panel = useDetailPanel()
  const navigate = useNavigate()

  const columns: CollectionColumn<HostedReview>[] = [
    {
      id: 'recorded',
      label: 'Recorded',
      phone: 'line',
      render: (row) => runEasternTime(row.recordedAt, true),
    },
    { id: 'space', label: 'Space', phone: 'line', render: (row) => row.spaceName },
    {
      id: 'project',
      label: 'Project',
      phone: 'title',
      render: (row) => <ProjectMark name={row.projectName} colors={colors} />,
    },
    {
      id: 'tier',
      label: 'Tier',
      phone: 'aside',
      render: (row) => (row.tier == null ? '-' : String(row.tier)),
    },
    {
      id: 'lenses',
      label: 'Lenses',
      phone: 'more',
      numeric: true,
      render: (row) => row.lensCount ?? '-',
    },
    {
      id: 'findings',
      label: 'Findings',
      phone: 'more',
      numeric: true,
      render: (row) => row.findingCount ?? '-',
    },
    {
      id: 'open',
      label: '',
      render: () => <ChevronRight size={14} className="text-text-muted" />,
    },
  ]

  return (
    <section>
      <PageHeader
        title="Reviews"
        subtitle={pending && !rows.length ? 'Loading reviews...' : `${rows.length} loaded`}
      />
      {loadMore.error ? (
        <p data-tone="error" className="text-status-text">
          could not load: {loadMore.error}
        </p>
      ) : null}
      <Collection
        panel={panel}
        title="Reviews"
        count={rows.length}
        columns={columns}
        rows={rows}
        getKey={(row) => row.id}
        onOpen={(row) =>
          void navigate({ to: '/reviews/$id', params: { id: row.id }, resetScroll: false })
        }
        empty={{ title: pending ? 'Loading reviews...' : 'No reviews in this space.' }}
      />
      {loadMore.available ? (
        <div className="mt-4">
          <Button variant="secondary" size="sm" disabled={loadMore.pending} onClick={loadMore.run}>
            {loadMore.pending ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

type HostedReviewDetail = {
  lenses?: RunDetailReviewLens[] | null
  projectName?: string | null
  tier?: number | null
  spaceName: string
  recordedAt: string
  completedAt?: string | null
}

export function HostedReviewDetail({
  id,
  review,
  colors,
  pending,
  error,
}: {
  id: string
  review: HostedReviewDetail | null
  colors: ProjectColors
  pending: boolean
  error: string | null
}) {
  const navigate = useNavigate()
  const close = () => void navigate({ to: '/reviews', resetScroll: false })

  if (pending) {
    return (
      <Companion onClose={close} title={`Review ${id}`} subtitle="Loading review...">
        <p className="text-text-muted">Loading...</p>
      </Companion>
    )
  }
  if (error || !review) {
    return (
      <Companion onClose={close} title={`Review ${id}`}>
        <p data-tone="error" className="text-status-text">
          Could not load this review. {error ?? 'Not found'}
        </p>
      </Companion>
    )
  }

  const lenses = review.lenses ?? []
  const projectName = typeof review.projectName === 'string' ? review.projectName : null
  return (
    <Companion
      onClose={close}
      title={`Review ${id}`}
      subtitle={projectName ?? undefined}
      actions={typeof review.tier === 'number' ? <Badge>tier {review.tier}</Badge> : undefined}
    >
      <DisplayRow label="Project" value={<ProjectMark name={projectName} colors={colors} />} />
      <DisplayRow label="Space" value={String(review.spaceName)} />
      <DisplayRow label="Recorded" value={String(review.recordedAt)} />
      <DisplayRow
        label="Completed"
        value={review.completedAt == null ? '-' : String(review.completedAt)}
      />
      <ReviewLensList lenses={lenses} />
    </Companion>
  )
}
