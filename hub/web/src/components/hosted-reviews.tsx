import { useQuery } from '@tanstack/react-query'
import { Outlet, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Collection, type CollectionColumn } from '@/components/collection'
import { PageHeader, ProjectMark } from '@/components/design-system'
import { DisplayRow, FieldSection } from '@/components/fields'
import { hostedProjectColors } from '@/components/hosted-projects'
import { Sheet } from '@/components/sheet'
import { runEasternTime } from '@/lib/run-search'
import { trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Button } from '@/ui/button/button'

type HostedReview = {
  id: string
  recordedAt: string
  projectName?: string | null
  completedAt?: string | null
  tier?: number | null
  lensCount?: number
  findingCount?: number
}

export type HostedLens = {
  id?: string
  lens?: string
  agent?: string
  findings?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function field(record: Record<string, unknown>, camel: string, snake: string) {
  const value = record[camel] ?? record[snake]
  return value == null ? '' : String(value)
}

export function HostedLensList({ lenses }: { lenses: HostedLens[] }) {
  if (!lenses.length) return <p className="mt-4 text-muted-foreground">No review lenses.</p>
  return (
    <div className="mt-4 space-y-6">
      {lenses.map((lens, index) => {
        const findings = Array.isArray(lens.findings) ? lens.findings : []
        return (
          <FieldSection
            key={lens.id ?? `${lens.lens ?? 'lens'}-${index}`}
            title={lens.lens ?? `Lens ${index + 1}`}
            description={lens.agent}
          >
            {findings.length ? (
              findings.map((item, findingIndex) => {
                const finding = asRecord(item)
                return (
                  <div
                    key={field(finding, 'id', 'id') || String(findingIndex)}
                    className="border border-border p-3"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Badge>{field(finding, 'severity', 'severity')}</Badge>
                      <span className="text-muted-foreground">
                        {field(finding, 'location', 'location')}
                      </span>
                    </div>
                    <p>{field(finding, 'evidence', 'evidence')}</p>
                    {field(finding, 'proposedCorrection', 'proposed_correction') ? (
                      <p className="mt-2 text-muted-foreground">
                        {field(finding, 'proposedCorrection', 'proposed_correction')}
                      </p>
                    ) : null}
                  </div>
                )
              })
            ) : (
              <p className="text-muted-foreground">No findings.</p>
            )}
          </FieldSection>
        )
      })}
    </div>
  )
}

export function HostedReviews() {
  return (
    <>
      <HostedReviewsList />
      <Outlet />
    </>
  )
}

function HostedReviewsList() {
  const navigate = useNavigate()
  const [pages, setPages] = useState<HostedReview[][]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const projects = useQuery(trpc.record.projects.queryOptions())
  const colors = hostedProjectColors(projects.data ?? [])
  const query = useQuery(trpc.record.reviews.queryOptions({ limit: 20, cursor }))
  const applied = query.data
  const rows = applied
    ? cursor
      ? [...pages.flat(), ...applied.items]
      : applied.items
    : pages.flat()

  const columns: CollectionColumn<HostedReview>[] = [
    {
      id: 'recorded',
      label: 'Recorded',
      render: (row) => runEasternTime(row.recordedAt, true),
    },
    {
      id: 'project',
      label: 'Project',
      render: (row) => <ProjectMark name={row.projectName} colors={colors} />,
    },
    {
      id: 'tier',
      label: 'Tier',
      render: (row) => (row.tier == null ? '-' : String(row.tier)),
    },
    { id: 'lenses', label: 'Lenses', numeric: true, render: (row) => row.lensCount ?? '-' },
    {
      id: 'findings',
      label: 'Findings',
      numeric: true,
      render: (row) => row.findingCount ?? '-',
    },
    {
      id: 'open',
      label: '',
      render: () => <ChevronRight size={14} className="text-muted-foreground" />,
    },
  ]

  return (
    <section>
      <PageHeader
        title="Reviews"
        subtitle={query.isPending && !rows.length ? 'Loading reviews...' : `${rows.length} loaded`}
      />
      {query.error ? (
        <p className="text-destructive">could not load: {query.error.message}</p>
      ) : null}
      <Collection
        title="Reviews"
        count={rows.length}
        columns={columns}
        rows={rows}
        getKey={(row) => row.id}
        onOpen={(row) => void navigate({ to: '/reviews/$id', params: { id: row.id } })}
        empty={{ title: query.isPending ? 'Loading reviews...' : 'No reviews in this space.' }}
      />
      {applied?.nextCursor ? (
        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            disabled={query.isFetching}
            onClick={() => {
              setPages((current) => [...current, applied.items])
              setCursor(applied.nextCursor ?? undefined)
            }}
          >
            {query.isFetching ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export function HostedReviewDetail({ id }: { id: string }) {
  const navigate = useNavigate()
  const detail = useQuery(trpc.record.review.queryOptions({ id }))
  const projects = useQuery(trpc.record.projects.queryOptions())
  const colors = hostedProjectColors(projects.data ?? [])
  const close = () => void navigate({ to: '/reviews' })
  const review = detail.data

  if (detail.isPending) {
    return (
      <Sheet open onClose={close} title={`Review ${id}`} subtitle="Loading review...">
        <p className="text-muted-foreground">Loading...</p>
      </Sheet>
    )
  }
  if (detail.error || !review) {
    return (
      <Sheet open onClose={close} title={`Review ${id}`}>
        <p className="text-destructive">
          Could not load this review. {detail.error?.message ?? 'Not found'}
        </p>
      </Sheet>
    )
  }

  const lenses = (review.lenses ?? []) as HostedLens[]
  const projectName = typeof review.projectName === 'string' ? review.projectName : null
  return (
    <Sheet
      open
      onClose={close}
      title={`Review ${id}`}
      subtitle={projectName ?? undefined}
      actions={typeof review.tier === 'number' ? <Badge>tier {review.tier}</Badge> : undefined}
    >
      <DisplayRow label="Project" value={<ProjectMark name={projectName} colors={colors} />} />
      <DisplayRow label="Recorded" value={String(review.recordedAt)} />
      <DisplayRow
        label="Completed"
        value={review.completedAt == null ? '-' : String(review.completedAt)}
      />
      <HostedLensList lenses={lenses} />
    </Sheet>
  )
}
