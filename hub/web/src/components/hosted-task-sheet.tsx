import { Badge } from '@bottega/hub-ui/badge'
import { Companion } from '@bottega/hub-ui/companion'
import { DisplayRow, FieldSection } from '@bottega/hub-ui/form-layout'
import { Identifier } from '@bottega/hub-ui/identifier'
import { Markdown } from '@bottega/hub-views/markdown'
import { TaskHistory } from '@bottega/hub-views/task-history'
import { relativeTime } from '@/lib/format'
import { taskHistoryEntries } from '@/lib/task-history'
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
            <TaskHistory
              entries={taskHistoryEntries(detail)}
              comment={{
                run: result.actions.comment.run,
                pending: result.actions.comment.pending,
                error: result.actions.comment.error?.message ?? null,
                refused: result.actions.comment.refused,
              }}
              editComment={{
                ...result.actions.editComment,
                error: result.actions.editComment.error?.message ?? null,
              }}
              deleteComment={{
                ...result.actions.deleteComment,
                error: result.actions.deleteComment.error?.message ?? null,
              }}
            />
          </div>
        </>
      ) : null}
    </Companion>
  )
}
