import { useQuery } from '@tanstack/react-query'
import { relativeTime } from '@/lib/format'
import { taskStatusLook } from '@/lib/task-status'
import { trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { Companion } from '@/ui/companion/companion'
import { DisplayRow, FieldSection } from '@/ui/form-layout/form-layout'
import { Identifier } from '@/ui/identifier/identifier'
import { ProjectMark, SourceMark } from './design-system'
import { Markdown } from './markdown'

type HostedDetail = {
  task: {
    key: string
    project: string
    title: string | null
    status: string | null
    status_category: string | null
    parent_key: string | null
    body: string | null
    assignee: string | null
    source: string
    updated_at: string
  }
  comments: { id: string; body: string; created_at: string }[]
  documents: {
    id: string
    role: string | null
    title: string
    body: string
    version: string
    updated_at: string
  }[]
  statusHistory: {
    id: string
    at: string
    from_status: string | null
    to_status: string
  }[]
  intervals: {
    source: string
    agent: string | null
    job: string | null
    start_at: string
    end_at: string
    open: number
  }[]
}

function Documents({ rows }: { rows: HostedDetail['documents'] }) {
  if (!rows.length) return <p className="text-text-muted">No documents.</p>
  return rows.map((document) => (
    <article key={document.id} className="border-b border-border-default py-3">
      <div className="mb-2 flex items-center gap-2">
        <strong>{document.title}</strong>
        {document.role ? <Badge tone="info">{document.role}</Badge> : null}
        <span className="text-xs text-text-muted">version {document.version}</span>
      </div>
      <Markdown content={document.body} />
    </article>
  ))
}

function Comments({ rows }: { rows: HostedDetail['comments'] }) {
  if (!rows.length) return <p className="text-text-muted">No comments.</p>
  return rows.map((comment) => (
    <article key={comment.id} className="border-b border-border-default py-3">
      <Markdown content={comment.body} />
      <div className="mt-2 text-xs text-text-muted">{relativeTime(comment.created_at)}</div>
    </article>
  ))
}

function StatusHistory({ rows }: { rows: HostedDetail['statusHistory'] }) {
  if (!rows.length) return <p className="text-text-muted">No status history.</p>
  return rows.map((event) => (
    <div key={event.id} className="border-b border-border-default py-2">
      <strong>{event.from_status ?? 'unknown'}</strong> → <strong>{event.to_status}</strong>
      <span className="ml-2 text-xs text-text-muted">{relativeTime(event.at)}</span>
    </div>
  ))
}

function Intervals({ rows }: { rows: HostedDetail['intervals'] }) {
  if (!rows.length) return <p className="text-text-muted">No intervals.</p>
  return rows.map((item) => (
    <div
      key={`${item.source}:${item.start_at}:${item.agent ?? ''}`}
      className="border-b border-border-default py-2"
    >
      <strong>{item.agent ?? item.source}</strong>
      {item.job ? ` · ${item.job}` : ''}
      <span className="ml-2 text-xs text-text-muted">
        {item.open ? 'running' : relativeTime(item.end_at)}
      </span>
    </div>
  ))
}

export function HostedTaskSheet({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  const query = useQuery(trpc.record.task.queryOptions({ key: taskKey }))
  const detail = query.data as HostedDetail | undefined
  return (
    <Companion
      onClose={onClose}
      title={
        detail ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Identifier>{detail.task.key}</Identifier>
            <ProjectMark name={detail.task.project} />
          </span>
        ) : (
          taskKey
        )
      }
      subtitle={detail?.task.title ?? 'Loading task...'}
    >
      {query.error ? (
        <p data-tone="error" className="text-status-text">
          {query.error.message}
        </p>
      ) : null}
      {detail ? (
        <>
          <DisplayRow
            label="Status"
            value={
              detail.task.status_category ? (
                <Badge {...taskStatusLook(detail.task.status_category)}>
                  {detail.task.status ?? detail.task.status_category}
                </Badge>
              ) : (
                (detail.task.status ?? 'unknown')
              )
            }
          />
          <DisplayRow label="Assignee" value={detail.task.assignee ?? 'unassigned'} />
          <DisplayRow label="Parent" value={detail.task.parent_key ?? '-'} />
          <DisplayRow label="Updated" value={relativeTime(detail.task.updated_at)} />
          <DisplayRow
            label="Source"
            value={
              <span className="inline-flex items-center gap-2">
                <SourceMark source={detail.task.source} project={detail.task.project} />
                {detail.task.source === 'local' ? 'hub' : detail.task.source}
              </span>
            }
          />
          <div className="mt-6 space-y-6">
            {detail.task.body ? (
              <FieldSection title="Description">
                <Markdown content={detail.task.body} />
              </FieldSection>
            ) : null}
            <FieldSection title="Documents">
              <Documents rows={detail.documents} />
            </FieldSection>
            <FieldSection title="Comments">
              <Comments rows={detail.comments} />
            </FieldSection>
            <FieldSection title="Status history">
              <StatusHistory rows={detail.statusHistory} />
            </FieldSection>
            <FieldSection title="Intervals">
              <Intervals rows={detail.intervals} />
            </FieldSection>
          </div>
        </>
      ) : null}
    </Companion>
  )
}
