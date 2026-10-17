import { Badge } from '@bottega/hub-ui/badge'
import { Companion } from '@bottega/hub-ui/companion'
import { DisplayRow, FieldSection } from '@bottega/hub-ui/form-layout'
import { Identifier } from '@bottega/hub-ui/identifier'
import { Markdown } from '@bottega/hub-views/markdown'
import { relativeTime } from '@/lib/format'
import { taskStatusLook } from '@/lib/task-status'
import type { TaskSheetDetail, TaskSheetResult } from '@/routes/-task-sheet-data'
import { ProjectMark, SourceMark } from './design-system'
import { MeasuresSummary } from './measure-display'

function Documents({ rows }: { rows: TaskSheetDetail['documents'] }) {
  if (!rows.length) return <p className="text-text-muted">No documents.</p>
  return rows.map((document) => (
    <article key={document.id} className="border-b border-border-default py-3">
      <div className="mb-2 flex items-center gap-2">
        <Identifier>{document.label}</Identifier>
        <strong>{document.title}</strong>
        {document.role ? <Badge tone="info">{document.role}</Badge> : null}
        <span className="text-xs text-text-muted">version {document.version}</span>
      </div>
      <Markdown content={document.body} />
    </article>
  ))
}

function Comments({ rows }: { rows: TaskSheetDetail['comments'] }) {
  if (!rows.length) return <p className="text-text-muted">No comments.</p>
  return rows.map((comment) => (
    <article key={comment.id} className="border-b border-border-default py-3">
      <Markdown content={comment.body} />
      <div className="mt-2 text-xs text-text-muted">{relativeTime(comment.createdAt)}</div>
    </article>
  ))
}

function StatusHistory({ rows }: { rows: TaskSheetDetail['statusEvents'] }) {
  if (!rows.length) return <p className="text-text-muted">No status history.</p>
  return rows.map((event) => (
    <div key={event.id} className="border-b border-border-default py-2">
      <strong>{event.fromStatus ?? 'unknown'}</strong> → <strong>{event.toStatus}</strong>
      <span className="ml-2 text-xs text-text-muted">{relativeTime(event.at)}</span>
    </div>
  ))
}

function Intervals({ rows }: { rows: TaskSheetDetail['runs'] }) {
  if (!rows.length) return <p className="text-text-muted">No intervals.</p>
  return rows.map((item) => (
    <div
      key={`${item.id}:${item.startedAt}:${item.agent ?? ''}`}
      className="border-b border-border-default py-2"
    >
      <strong>{item.agent ?? '-'}</strong>
      {item.job ? ` · ${item.job}` : ''}
      <span className="ml-2 text-xs text-text-muted">
        {item.running ? 'running' : relativeTime(item.endedAt)}
      </span>
    </div>
  ))
}

function HostedStatus({ detail }: { detail: TaskSheetDetail }) {
  if (!detail.task.statusCategory) return detail.task.status ?? 'unknown'
  return (
    <Badge {...taskStatusLook(detail.task.statusCategory)}>
      {detail.task.status ?? detail.task.statusCategory}
    </Badge>
  )
}

export function HostedTaskSheet({
  taskKey,
  result,
  onClose,
}: {
  taskKey: string
  result: TaskSheetResult
  onClose: () => void
}) {
  const separator = taskKey.indexOf(':')
  const key = separator > 0 ? taskKey.slice(separator + 1) : taskKey
  const detail = result.detail
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
          key
        )
      }
      subtitle={detail?.task.title ?? 'Loading task...'}
    >
      {result.error ? (
        <p data-tone="error" className="text-status-text">
          {result.error.message}
        </p>
      ) : null}
      {detail ? (
        <>
          <DisplayRow label="Status" value={<HostedStatus detail={detail} />} />
          <DisplayRow label="Space" value={String(detail.task.spaceName)} />
          <DisplayRow label="Assignee" value={detail.task.assignee ?? 'unassigned'} />
          <DisplayRow label="Parent" value={detail.task.parentKey ?? '-'} />
          <DisplayRow
            label="Updated"
            value={detail.task.updatedAt ? relativeTime(detail.task.updatedAt) : '-'}
          />
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
            <FieldSection title="Measures">
              {detail.measureCoverage && !detail.measureCoverage.hasRecordedTime ? (
                <p className="mb-3 text-text-muted">
                  No time was recorded for this task; the zero measures reflect missing coverage.
                </p>
              ) : null}
              {detail.measures ? (
                <MeasuresSummary measures={detail.measures} showShipped={false} />
              ) : null}
            </FieldSection>
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
              <StatusHistory rows={detail.statusEvents} />
            </FieldSection>
            <FieldSection title="Intervals">
              <Intervals rows={detail.runs} />
            </FieldSection>
          </div>
        </>
      ) : null}
    </Companion>
  )
}
